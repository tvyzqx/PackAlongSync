// guest-view  (deployed as pa-guest-view, --no-verify-jwt)
//
// Public web page for a single guest's packing list on a single trip
// (Issue #1). Reached without any app install via
//   https://api.7-tm.de/functions/v1/pa-guest-view?token=<token>
// The token is minted by pa-generate-guest-share and stored in
// packalong.guest_share_links.
//
// This endpoint is anonymous (verify_jwt = false) but reads with the service
// role, so it is the ONLY door to guest_share_links (RLS keeps the anon role
// out of the table). Data exposure is deliberately narrow: one guest, one
// trip, that guest's own items. Defenses: unguessable token, optional expiry,
// revoke flag, and light per-IP rate limiting.
//
// The guest may set the status of their own items while the trip has not
// started yet (see EDIT WINDOW below). Edits are staged in the browser and
// POSTed back in one batch when the guest presses save — there is no live
// sync from this page. The write path re-resolves the link and re-checks the
// edit window server-side; the browser is never trusted with scope. Because
// every guest link is writable during that window, the token IS a write
// credential for exactly one guest's items on one trip: worst case a leaked
// link means wrong checkboxes, never data exposure beyond what the page
// already shows. Writes touch only items.status, so the circle picks the
// change up through the normal updated_at/realtime path with no attribution
// of who flipped it — deliberately, per product decision.
//
// EDIT WINDOW: editable until the END of the trip's start day (inclusive) in
// EDIT_TIMEZONE. A trip without a start_date has no cutoff and stays editable
// for the life of the link. Once the trip has started the page falls back to
// the read-only rendering, and it keeps serving that view past end_date until
// expires_at or a revoke closes it.
//
// When the guest profile has an email and a live companion invite, the page
// offers an email-bound "get the app & join" button. The invite is bound to
// the guest's address, so the public link is not itself a join credential —
// join-circle only admits a caller authenticated as that email.

import {
  createPackalongAdmin,
  type PackalongClient,
} from "../_shared/packalong_client.ts";
import { withinEditWindow } from "../_shared/edit_window.ts";

// Light best-effort rate limiting. The edge isolate is reused across
// requests, so a module-level map survives between calls in the same worker.
// It is not a hard guarantee (multiple workers, cold starts) — just a cheap
// brake on scraping a leaked token. Reads and writes get separate buckets:
// a save is one batched request, so a much lower ceiling still leaves honest
// use untouched while capping what a leaked token can churn.
const RATE_LIMIT_WINDOW_MS = 60_000;
const READ_RATE_LIMIT_MAX = 60;
const WRITE_RATE_LIMIT_MAX = 10;
const readBuckets = new Map<string, { count: number; resetAt: number }>();
const writeBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(
  buckets: Map<string, { count: number; resetAt: number }>,
  key: string,
  max: number,
): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

// Statuses the guest may set, mirroring packalong.items' check constraint
// (006). Anything outside this set is rejected before it reaches the DB.
const GUEST_SETTABLE_STATUSES = new Set([
  "open",
  "packed",
  "toBuy",
  "unclear",
  "planning",
]);

// One save carries only the items the guest actually touched, so this ceiling
// is far above any real packing list while still bounding the per-request work.
const MAX_CHANGES_PER_SAVE = 200;

type ItemRow = {
  id: string;
  title: string;
  status: string;
  quantity: number;
  note: string | null;
  container_id: string | null;
  category: string | null;
  sort_order: number;
};

type ShareLink = {
  token: string;
  trip_id: string;
  profile_id: string;
  companion_invite_token: string | null;
};

/** Why a link cannot be served, or null when it is live. */
type LinkRejection = { title: string; message: string; status: number };

/**
 * Resolve a share token to a live link. Both the page render and the save
 * path go through this, so a revoked or expired link cannot be written to
 * just because the browser still has the page open.
 */
async function resolveLink(
  admin: PackalongClient,
  token: string,
): Promise<{ link: ShareLink | null; rejection: LinkRejection | null }> {
  const { data, error } = await admin
    .from("guest_share_links")
    .select("token, trip_id, profile_id, expires_at, revoked_at, companion_invite_token")
    .eq("token", token)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      link: null,
      rejection: { title: "Nicht gefunden", message: "Dieser Link ist ungültig.", status: 404 },
    };
  }
  if (data.revoked_at) {
    return {
      link: null,
      rejection: {
        title: "Zurückgezogen",
        message: "Dieser Freigabelink wurde zurückgezogen.",
        status: 410,
      },
    };
  }
  if (data.expires_at && new Date(data.expires_at as string).getTime() <= Date.now()) {
    return {
      link: null,
      rejection: {
        title: "Abgelaufen",
        message: "Dieser Freigabelink ist abgelaufen. Bitte frage nach einem neuen.",
        status: 410,
      },
    };
  }
  return {
    link: {
      token: data.token as string,
      trip_id: data.trip_id as string,
      profile_id: data.profile_id as string,
      companion_invite_token: data.companion_invite_token as string | null,
    },
    rejection: null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") || "unknown";

  if (req.method === "POST") {
    return await handleSave(req, clientIp);
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return htmlResponse(errorPage("Nicht erlaubt", "Diese Seite wird nur per Aufruf im Browser angezeigt."), 405);
  }

  if (rateLimited(readBuckets, clientIp, READ_RATE_LIMIT_MAX)) {
    return htmlResponse(
      errorPage("Zu viele Anfragen", "Bitte versuche es in einer Minute erneut."),
      429,
    );
  }

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !serviceRoleKey) {
      return htmlResponse(errorPage("Nicht verfügbar", "Der Server ist nicht korrekt konfiguriert."), 500);
    }

    const token = new URL(req.url).searchParams.get("token")?.trim() ?? "";
    if (!token) {
      return htmlResponse(errorPage("Link unvollständig", "Dieser Link enthält kein Token."), 400);
    }

    const admin = createPackalongAdmin(url, serviceRoleKey);

    const { link, rejection } = await resolveLink(admin, token);
    if (!link) {
      return htmlResponse(errorPage(rejection!.title, rejection!.message), rejection!.status);
    }

    const [tripRes, guestRes] = await Promise.all([
      admin
        .from("trips")
        .select("title, emoji, template_emoji, start_date, end_date, deleted")
        .eq("id", link.trip_id)
        .maybeSingle(),
      admin
        .from("profiles")
        .select("name, avatar_emoji, avatar_color, email, deleted")
        .eq("id", link.profile_id)
        .maybeSingle(),
    ]);
    if (tripRes.error) throw tripRes.error;
    if (guestRes.error) throw guestRes.error;
    const trip = tripRes.data;
    const guest = guestRes.data;
    if (!trip || trip.deleted || !guest || guest.deleted) {
      return htmlResponse(errorPage("Nicht mehr verfügbar", "Diese Reise oder dieser Gast existiert nicht mehr."), 404);
    }

    const items = await loadGuestItems(admin, link);

    // Resolve container names for grouping.
    const containerIds = [
      ...new Set(items.map((i) => i.container_id).filter((c): c is string => !!c)),
    ];
    const containersById = new Map<string, { name: string; icon: string | null }>();
    if (containerIds.length > 0) {
      const { data: containers, error: containersError } = await admin
        .from("pack_containers")
        .select("id, name, icon")
        .in("id", containerIds);
      if (containersError) throw containersError;
      for (const c of containers ?? []) {
        containersById.set(c.id as string, { name: c.name as string, icon: (c.icon as string | null) });
      }
    }

    // Is the "join" button live? Only when the guest has an email and the
    // companion invite is still open and unexpired.
    let joinToken: string | null = null;
    if (guest.email && link.companion_invite_token) {
      const { data: invite, error: inviteError } = await admin
        .from("circle_invites")
        .select("token, consumed_at, expires_at")
        .eq("token", link.companion_invite_token)
        .maybeSingle();
      if (inviteError) throw inviteError;
      if (
        invite && !invite.consumed_at &&
        new Date(invite.expires_at).getTime() > Date.now()
      ) {
        joinToken = invite.token as string;
      }
    }

    const page = renderPage({
      trip,
      guest,
      items,
      containersById,
      joinToken,
      token,
      editable: withinEditWindow(trip.start_date as string | null),
    });
    return htmlResponse(page, 200);
  } catch (_error) {
    return htmlResponse(
      errorPage("Etwas ist schiefgelaufen", "Diese Seite konnte gerade nicht geladen werden. Bitte versuche es später erneut."),
      500,
    );
  }
});

// data --------------------------------------------------------------------

/** The guest's own items on the trip: on their packing list OR assigned to them. */
async function loadGuestItems(
  admin: PackalongClient,
  link: ShareLink,
): Promise<ItemRow[]> {
  const { data, error } = await admin
    .from("items")
    .select("id, title, status, quantity, note, container_id, category, sort_order")
    .eq("trip_id", link.trip_id)
    .eq("deleted", false)
    .or(`pack_list_person_id.eq.${link.profile_id},assigned_to_person_id.eq.${link.profile_id}`);
  if (error) throw error;
  return (data ?? []) as ItemRow[];
}

// saving ------------------------------------------------------------------

/**
 * Apply a batch of guest status changes. Everything the browser sends is
 * treated as a claim to re-verify: the token is re-resolved, the edit window
 * re-checked against the trip, each status matched against the allow-list,
 * and every id checked against the guest's own items — the exact set the page
 * renders, loaded through the same loadGuestItems() — so an id lifted from
 * elsewhere is dropped rather than written. Only `status` is ever written: the
 * client-mirror columns (dirty/synced_at/dirty_fields) and every other field
 * stay untouched, and the items_set_updated_at trigger carries the change to
 * the circle over realtime.
 */
async function handleSave(req: Request, clientIp: string): Promise<Response> {
  if (rateLimited(writeBuckets, clientIp, WRITE_RATE_LIMIT_MAX)) {
    return jsonResponse({ error: "Zu viele Anfragen. Bitte kurz warten." }, 429);
  }

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !serviceRoleKey) {
      return jsonResponse({ error: "Der Server ist nicht korrekt konfiguriert." }, 500);
    }

    let body: { token?: unknown; changes?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Ungültige Anfrage." }, 400);
    }

    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      return jsonResponse({ error: "Dieser Link enthält kein Token." }, 400);
    }

    if (!Array.isArray(body.changes)) {
      return jsonResponse({ error: "Ungültige Anfrage." }, 400);
    }
    if (body.changes.length === 0) {
      return jsonResponse({ saved: 0 }, 200);
    }
    if (body.changes.length > MAX_CHANGES_PER_SAVE) {
      return jsonResponse({ error: "Zu viele Änderungen auf einmal." }, 400);
    }

    const changes: { id: string; status: string }[] = [];
    for (const raw of body.changes) {
      const change = raw as { id?: unknown; status?: unknown };
      if (typeof change.id !== "string" || typeof change.status !== "string") {
        return jsonResponse({ error: "Ungültige Anfrage." }, 400);
      }
      if (!GUEST_SETTABLE_STATUSES.has(change.status)) {
        return jsonResponse({ error: "Unbekannter Status." }, 400);
      }
      changes.push({ id: change.id, status: change.status });
    }

    const admin = createPackalongAdmin(url, serviceRoleKey);

    const { link, rejection } = await resolveLink(admin, token);
    if (!link) {
      return jsonResponse({ error: rejection!.message }, rejection!.status);
    }

    const { data: trip, error: tripError } = await admin
      .from("trips")
      .select("start_date, deleted")
      .eq("id", link.trip_id)
      .maybeSingle();
    if (tripError) throw tripError;
    if (!trip || trip.deleted) {
      return jsonResponse({ error: "Diese Reise existiert nicht mehr." }, 404);
    }
    // The page may have sat open since before the trip started.
    if (!withinEditWindow(trip.start_date as string | null)) {
      return jsonResponse(
        { error: "Die Reise hat begonnen — die Liste kann nicht mehr geändert werden." },
        409,
      );
    }

    // The authoritative scope: exactly the rows the page would render right
    // now. Resolving it up front (rather than filtering each UPDATE by
    // ownership) keeps "which items are the guest's" in one place, and
    // sidesteps PostgREST rejecting an `or=` filter on a mutation.
    const allowedIds = new Set((await loadGuestItems(admin, link)).map((i) => i.id));

    let saved = 0;
    for (const change of changes) {
      if (!allowedIds.has(change.id)) continue;
      const { error } = await admin
        .from("items")
        .update({ status: change.status })
        .eq("id", change.id)
        .eq("trip_id", link.trip_id)
        .eq("deleted", false);
      if (error) throw error;
      saved += 1;
    }

    // A short count means some items left the guest's scope since the page
    // loaded — deleted, reassigned, moved. The rest of the save still stands;
    // the page reloads afterwards and shows what is actually there now.
    return jsonResponse({ saved, requested: changes.length }, 200);
  } catch (_error) {
    return jsonResponse(
      { error: "Das Speichern hat gerade nicht geklappt. Bitte später erneut versuchen." },
      500,
    );
  }
}

// rendering ---------------------------------------------------------------

const STATUS_META: Record<string, { emoji: string; label: string }> = {
  packed: { emoji: "✅", label: "Gepackt" },
  toBuy: { emoji: "🛒", label: "Zu kaufen" },
  open: { emoji: "⬜", label: "Offen" },
  unclear: { emoji: "❓", label: "Unklar" },
  planning: { emoji: "🗓️", label: "Planung" },
};

const NO_CONTAINER = "Ohne Behälter";
const NO_CATEGORY = "Sonstiges";

// Order the guest picks from. Mirrors GUEST_SETTABLE_STATUSES, but ordered
// for the dropdown: the two everyday answers first.
const STATUS_CHOICES = ["open", "packed", "toBuy", "unclear", "planning"];

function renderPage({
  trip,
  guest,
  items,
  containersById,
  joinToken,
  token,
  editable,
}: {
  trip: Record<string, unknown>;
  guest: Record<string, unknown>;
  items: ItemRow[];
  containersById: Map<string, { name: string; icon: string | null }>;
  joinToken: string | null;
  token: string;
  editable: boolean;
}): string {
  const tripEmoji = (trip.emoji as string | null) || (trip.template_emoji as string | null) || "🧳";
  const tripTitle = esc((trip.title as string | null) ?? "Reise");
  const dateRange = formatDateRange(trip.start_date as string | null, trip.end_date as string | null);
  const guestName = esc((guest.name as string | null) ?? "Gast");
  const guestEmoji = (guest.avatar_emoji as string | null) || "🙂";

  const packed = items.filter((i) => i.status === "packed").length;
  const total = items.length;

  // Editing needs something to edit; an empty list stays a plain page.
  const canEdit = editable && total > 0;

  const groups = groupItems(items, containersById);
  const listHtml = total === 0
    ? `<p class="empty">Für ${guestName} sind auf dieser Reise noch keine Sachen eingetragen.</p>`
    : groups.map((group) => renderContainerGroup(group, canEdit)).join("");

  const joinHtml = renderJoinBlock(guest.email as string | null, joinToken);

  return `<main${canEdit ? ' class="editable"' : ""}>
  <header class="hero">
    <div class="trip-emoji">${esc(tripEmoji)}</div>
    <h1>${tripTitle}</h1>
    ${dateRange ? `<p class="dates">${esc(dateRange)}</p>` : ""}
    <div class="guest">
      <span class="guest-emoji">${esc(guestEmoji)}</span>
      <span>Packliste für <strong>${guestName}</strong></span>
    </div>
    ${total > 0 ? `<p class="progress">${packed} von ${total} gepackt</p>` : ""}
    ${
    canEdit
      ? `<p class="hint edit-hint">Du kannst den Status deiner Sachen ändern. Zum Übernehmen unten speichern.</p>`
      : total > 0
      ? `<p class="hint">Diese Ansicht ist nur zum Anschauen.</p>`
      : ""
  }
  </header>

  <section class="list">
    ${listHtml}
  </section>

  ${canEdit ? renderSaveBar(token) : ""}

  ${joinHtml}

  <footer>
    <p class="report">
      Missbrauch oder unangemessene Inhalte?
      <a href="mailto:report@packalong.org?subject=Report%20guest%20view">Melden</a>.
      Nutzung unterliegt der EULA; gemeldete Inhalte werden geprüft.
    </p>
    <p class="brand">PackAlong</p>
  </footer>
</main>`;
}

type ContainerGroup = {
  name: string;
  icon: string | null;
  categories: { name: string; items: ItemRow[] }[];
};

function groupItems(
  items: ItemRow[],
  containersById: Map<string, { name: string; icon: string | null }>,
): ContainerGroup[] {
  const byContainer = new Map<string, ContainerGroup>();
  // Stable key that keeps "no container" last.
  for (const item of items) {
    const container = item.container_id ? containersById.get(item.container_id) : null;
    const containerKey = item.container_id ?? "__none__";
    const containerName = container?.name ?? NO_CONTAINER;
    let group = byContainer.get(containerKey);
    if (!group) {
      group = { name: containerName, icon: container?.icon ?? null, categories: [] };
      byContainer.set(containerKey, group);
    }
    const categoryName = (item.category && item.category.trim().length > 0)
      ? item.category.trim()
      : NO_CATEGORY;
    let category = group.categories.find((c) => c.name === categoryName);
    if (!category) {
      category = { name: categoryName, items: [] };
      group.categories.push(category);
    }
    category.items.push(item);
  }

  const groups = [...byContainer.values()];
  // Order: named containers alphabetically, "no container" last.
  groups.sort((a, b) => {
    if (a.name === NO_CONTAINER) return 1;
    if (b.name === NO_CONTAINER) return -1;
    return a.name.localeCompare(b.name, "de");
  });
  for (const group of groups) {
    group.categories.sort((a, b) => a.name.localeCompare(b.name, "de"));
    for (const category of group.categories) {
      category.items.sort((a, b) =>
        (a.sort_order - b.sort_order) || a.title.localeCompare(b.title, "de")
      );
    }
  }
  return groups;
}

function renderContainerGroup(group: ContainerGroup, canEdit: boolean): string {
  const heading = `${group.icon ? esc(group.icon) + " " : ""}${esc(group.name)}`;
  const categories = group.categories.map((category) => {
    const rows = category.items.map((item) => renderItem(item, canEdit)).join("");
    const showCategory = category.name !== NO_CATEGORY || group.categories.length > 1;
    return `${showCategory ? `<h3 class="category">${esc(category.name)}</h3>` : ""}
      <ul>${rows}</ul>`;
  }).join("");
  return `<div class="container-group">
    <h2>${heading}</h2>
    ${categories}
  </div>`;
}

function renderItem(item: ItemRow, canEdit: boolean): string {
  const meta = STATUS_META[item.status] ?? STATUS_META.open;
  const qty = item.quantity && item.quantity > 1 ? ` <span class="qty">×${item.quantity}</span>` : "";
  const note = item.note && item.note.trim().length > 0
    ? `<span class="note">${esc(item.note.trim())}</span>`
    : "";
  const packedClass = item.status === "packed" ? " packed" : "";
  const title = `<span class="title">${esc(item.title)}${qty}${note}</span>`;

  if (!canEdit) {
    return `<li class="item${packedClass}">
    <span class="status" title="${esc(meta.label)}">${esc(meta.emoji)}</span>
    ${title}
  </li>`;
  }

  // data-initial lets the script send only what actually changed, and lets a
  // guest undo their way back to a clean state.
  const options = STATUS_CHOICES.map((value) => {
    const optionMeta = STATUS_META[value];
    return `<option value="${esc(value)}"${value === item.status ? " selected" : ""}>${
      esc(`${optionMeta.emoji} ${optionMeta.label}`)
    }</option>`;
  }).join("");
  const label = `Status von ${item.title}`;
  return `<li class="item${packedClass}" data-item="${esc(item.id)}" data-initial="${esc(item.status)}">
    ${title}
    <select class="status-select" aria-label="${esc(label)}">${options}</select>
  </li>`;
}

function renderSaveBar(token: string): string {
  return `<div class="savebar" hidden>
    <div class="savebar-inner">
      <span class="savebar-text" role="status"></span>
      <button type="button" class="btn primary save-btn">Speichern</button>
    </div>
  </div>
  <script>${saveScript(token)}</script>`;
}

/**
 * Staged editing: selects mutate nothing until the guest saves, at which point
 * the diff against data-initial goes up in one POST. On success the page
 * reloads, so what the guest sees afterwards is server truth rather than the
 * browser's optimistic guess — that also surfaces any item the save skipped
 * because it left the guest's scope meanwhile.
 */
function saveScript(token: string): string {
  // Escaping "<" keeps a token from ever closing the <script> element early.
  // Tokens are generator-minted and can't contain one, but the page is the
  // wrong place to rely on that.
  const literal = JSON.stringify(token).replaceAll("<", "\\u003C");
  return `
(function () {
  var token = ${literal};
  var bar = document.querySelector(".savebar");
  var text = bar.querySelector(".savebar-text");
  var button = bar.querySelector(".save-btn");
  var items = Array.prototype.slice.call(document.querySelectorAll(".item[data-item]"));

  function changed() {
    return items.filter(function (li) {
      return li.querySelector(".status-select").value !== li.dataset.initial;
    });
  }

  function refresh() {
    var count = changed().length;
    bar.hidden = count === 0;
    text.textContent = count === 1 ? "1 Änderung" : count + " Änderungen";
  }

  items.forEach(function (li) {
    li.querySelector(".status-select").addEventListener("change", function () {
      li.classList.toggle("packed", this.value === "packed");
      li.classList.add("touched");
      refresh();
    });
  });

  button.addEventListener("click", function () {
    var pending = changed();
    if (pending.length === 0) return;
    button.disabled = true;
    text.textContent = "Wird gespeichert …";
    fetch(window.location.pathname + window.location.search, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: token,
        changes: pending.map(function (li) {
          return { id: li.dataset.item, status: li.querySelector(".status-select").value };
        })
      })
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (result) {
      if (!result.ok) throw new Error(result.body && result.body.error);
      window.location.reload();
    }).catch(function (err) {
      button.disabled = false;
      bar.classList.add("error");
      text.textContent = (err && err.message) || "Speichern fehlgeschlagen.";
    });
  });

  // Losing staged edits to a stray back-swipe would be annoying.
  window.addEventListener("beforeunload", function (event) {
    if (!button.disabled && changed().length > 0) event.preventDefault();
  });

  refresh();
})();
`;
}

function renderJoinBlock(email: string | null, joinToken: string | null): string {
  const appHost = Deno.env.get("PUBLIC_APP_HOST") ?? "packalong.org";
  const downloadUrl = `https://${appHost}`;
  if (joinToken && email) {
    const joinUrl = `https://${appHost}/claim/${encodeURIComponent(joinToken)}`;
    return `<section class="cta">
      <a class="btn primary" href="${esc(joinUrl)}">App holen &amp; beitreten</a>
      <p class="hint">Zum Beitreten mit <strong>${esc(maskEmail(email))}</strong> registrieren oder anmelden.</p>
      <p class="fallback"><a href="${esc(downloadUrl)}">App noch nicht installiert? Hier laden.</a></p>
    </section>`;
  }
  return `<section class="cta">
    <a class="btn" href="${esc(downloadUrl)}">App laden</a>
    <p class="hint">Diese Ansicht ist nur zum Anschauen. Für einen eigenen Zugang bitte die App laden.</p>
  </section>`;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.slice(0, 1);
  return `${shown}${"•".repeat(Math.max(2, Math.min(local.length - 1, 3)))}@${domain}`;
}

function formatDateRange(start: string | null, end: string | null): string {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })
      .format(new Date(iso));
  if (start && end) {
    return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
  }
  if (start) return `ab ${fmt(start)}`;
  if (end) return `bis ${fmt(end)}`;
  return "";
}

// html plumbing -----------------------------------------------------------

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlResponse(body: string, status: number): Response {
  return new Response(document(body), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function errorPage(title: string, message: string): string {
  return `<main class="error">
    <div class="trip-emoji">🧳</div>
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
    <p class="brand">PackAlong</p>
  </main>`;
}

function document(inner: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>PackAlong – Gastansicht</title>
<style>
:root {
  --bg: #f5f5f7; --card: #ffffff; --fg: #1c1c1e; --muted: #6b6b70;
  --line: #e3e3e8; --accent: #2f6f4f; --accent-fg: #ffffff; --packed: #2f6f4f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f0f11; --card: #1c1c1f; --fg: #f2f2f4; --muted: #9a9aa0;
    --line: #2c2c30; --accent: #4cae82; --accent-fg: #0f0f11; --packed: #4cae82;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  padding: 24px 16px;
}
main { max-width: 640px; margin: 0 auto; }
.hero { text-align: center; margin-bottom: 28px; }
.trip-emoji { font-size: 44px; line-height: 1; }
h1 { font-size: 26px; margin: 10px 0 4px; }
.dates { color: var(--muted); margin: 0 0 12px; }
.guest {
  display: inline-flex; gap: 8px; align-items: center;
  background: var(--card); border: 1px solid var(--line);
  padding: 8px 14px; border-radius: 999px; margin-top: 4px;
}
.guest-emoji { font-size: 20px; }
.progress { color: var(--muted); margin: 12px 0 0; font-size: 14px; }
.list { display: flex; flex-direction: column; gap: 16px; }
.container-group {
  background: var(--card); border: 1px solid var(--line);
  border-radius: 14px; padding: 16px 18px;
}
.container-group h2 { font-size: 18px; margin: 0 0 10px; }
.category {
  font-size: 12px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--muted); margin: 14px 0 6px;
}
.category:first-of-type { margin-top: 0; }
ul { list-style: none; margin: 0; padding: 0; }
.item {
  display: flex; gap: 10px; align-items: baseline;
  padding: 8px 0; border-top: 1px solid var(--line);
}
.container-group ul .item:first-child { border-top: none; }
.item .status { font-size: 15px; flex: 0 0 auto; }
.item .title { flex: 1 1 auto; }
.item.packed .title { color: var(--muted); text-decoration: line-through; }
.qty { color: var(--muted); font-size: 14px; }
.note { display: block; color: var(--muted); font-size: 13px; margin-top: 2px; }
.empty { color: var(--muted); text-align: center; padding: 24px 0; }
.hint { color: var(--muted); font-size: 14px; margin: 12px 0 0; }
.status-select {
  flex: 0 0 auto; font: inherit; font-size: 14px; color: var(--fg);
  background: var(--bg); border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 8px; max-width: 45%;
}
.item.touched .status-select { border-color: var(--accent); }
/* Editable rows put the control on the right and align to it. */
main.editable .item { align-items: center; gap: 12px; }
/* The bar is fixed, so the list needs room to scroll clear of it. */
main.editable { padding-bottom: 80px; }
.savebar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 10;
  background: var(--card); border-top: 1px solid var(--line);
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
}
.savebar[hidden] { display: none; }
.savebar-inner {
  max-width: 640px; margin: 0 auto;
  display: flex; gap: 12px; align-items: center; justify-content: space-between;
}
.savebar-text { color: var(--muted); font-size: 14px; }
.savebar.error .savebar-text { color: #c2401f; }
.savebar .btn { padding: 10px 20px; }
.savebar .btn:disabled { opacity: .6; }
@media (prefers-color-scheme: dark) { .savebar.error .savebar-text { color: #ff8a66; } }
.cta {
  margin: 28px 0 8px; text-align: center;
  background: var(--card); border: 1px solid var(--line);
  border-radius: 14px; padding: 22px 18px;
}
.btn {
  display: inline-block; padding: 12px 22px; border-radius: 999px;
  border: 1px solid var(--accent); color: var(--accent);
  text-decoration: none; font-weight: 600;
}
.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.cta .hint { color: var(--muted); font-size: 14px; margin: 12px 0 0; }
.cta .fallback { font-size: 13px; margin: 8px 0 0; }
.cta .fallback a, .report a { color: var(--accent); }
footer { margin-top: 28px; text-align: center; }
.report { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
.brand { color: var(--muted); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
.error { text-align: center; padding-top: 40px; }
.error h1 { margin-top: 12px; }
.error p { color: var(--muted); }
</style>
</head>
<body>
${inner}
</body>
</html>`;
}
