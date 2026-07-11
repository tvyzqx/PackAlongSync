// guest-view  (deployed as pa-guest-view, --no-verify-jwt)
//
// Public, read-only web page for a single guest's packing list on a single
// trip (Issue #1). Reached without any app install via
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
// When the guest profile has an email and a live companion invite, the page
// offers an email-bound "get the app & join" button. The invite is bound to
// the guest's address, so the public link is not itself a join credential —
// join-circle only admits a caller authenticated as that email.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Light best-effort rate limiting. The edge isolate is reused across
// requests, so a module-level map survives between calls in the same worker.
// It is not a hard guarantee (multiple workers, cold starts) — just a cheap
// brake on scraping a leaked token.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

type ItemRow = {
  title: string;
  status: string;
  quantity: number;
  note: string | null;
  container_id: string | null;
  category: string | null;
  sort_order: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return htmlResponse(errorPage("Nicht erlaubt", "Diese Seite wird nur per Aufruf im Browser angezeigt."), 405);
  }

  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") || "unknown";
  if (rateLimited(clientIp)) {
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

    const admin = createClient(url, serviceRoleKey, {
      db: { schema: "packalong" },
    });

    const { data: link, error: linkError } = await admin
      .from("guest_share_links")
      .select("token, trip_id, profile_id, expires_at, revoked_at, companion_invite_token")
      .eq("token", token)
      .maybeSingle();
    if (linkError) throw linkError;
    if (!link) {
      return htmlResponse(errorPage("Nicht gefunden", "Dieser Link ist ungültig."), 404);
    }
    if (link.revoked_at) {
      return htmlResponse(errorPage("Zurückgezogen", "Dieser Freigabelink wurde zurückgezogen."), 410);
    }
    if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
      return htmlResponse(errorPage("Abgelaufen", "Dieser Freigabelink ist abgelaufen. Bitte frage nach einem neuen."), 410);
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

    // The guest's own items: on their packing list OR assigned to them.
    const { data: rawItems, error: itemsError } = await admin
      .from("items")
      .select("title, status, quantity, note, container_id, category, sort_order")
      .eq("trip_id", link.trip_id)
      .eq("deleted", false)
      .or(`pack_list_person_id.eq.${link.profile_id},assigned_to_person_id.eq.${link.profile_id}`);
    if (itemsError) throw itemsError;
    const items = (rawItems ?? []) as ItemRow[];

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
    });
    return htmlResponse(page, 200);
  } catch (_error) {
    return htmlResponse(
      errorPage("Etwas ist schiefgelaufen", "Diese Seite konnte gerade nicht geladen werden. Bitte versuche es später erneut."),
      500,
    );
  }
});

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

function renderPage({
  trip,
  guest,
  items,
  containersById,
  joinToken,
}: {
  trip: Record<string, unknown>;
  guest: Record<string, unknown>;
  items: ItemRow[];
  containersById: Map<string, { name: string; icon: string | null }>;
  joinToken: string | null;
}): string {
  const tripEmoji = (trip.emoji as string | null) || (trip.template_emoji as string | null) || "🧳";
  const tripTitle = esc((trip.title as string | null) ?? "Reise");
  const dateRange = formatDateRange(trip.start_date as string | null, trip.end_date as string | null);
  const guestName = esc((guest.name as string | null) ?? "Gast");
  const guestEmoji = (guest.avatar_emoji as string | null) || "🙂";

  const packed = items.filter((i) => i.status === "packed").length;
  const total = items.length;

  const groups = groupItems(items, containersById);
  const listHtml = total === 0
    ? `<p class="empty">Für ${guestName} sind auf dieser Reise noch keine Sachen eingetragen.</p>`
    : groups.map(renderContainerGroup).join("");

  const joinHtml = renderJoinBlock(guest.email as string | null, joinToken);

  return `<main>
  <header class="hero">
    <div class="trip-emoji">${esc(tripEmoji)}</div>
    <h1>${tripTitle}</h1>
    ${dateRange ? `<p class="dates">${esc(dateRange)}</p>` : ""}
    <div class="guest">
      <span class="guest-emoji">${esc(guestEmoji)}</span>
      <span>Packliste für <strong>${guestName}</strong></span>
    </div>
    ${total > 0 ? `<p class="progress">${packed} von ${total} gepackt</p>` : ""}
  </header>

  <section class="list">
    ${listHtml}
  </section>

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

function renderContainerGroup(group: ContainerGroup): string {
  const heading = `${group.icon ? esc(group.icon) + " " : ""}${esc(group.name)}`;
  const categories = group.categories.map((category) => {
    const rows = category.items.map(renderItem).join("");
    const showCategory = category.name !== NO_CATEGORY || group.categories.length > 1;
    return `${showCategory ? `<h3 class="category">${esc(category.name)}</h3>` : ""}
      <ul>${rows}</ul>`;
  }).join("");
  return `<div class="container-group">
    <h2>${heading}</h2>
    ${categories}
  </div>`;
}

function renderItem(item: ItemRow): string {
  const meta = STATUS_META[item.status] ?? STATUS_META.open;
  const qty = item.quantity && item.quantity > 1 ? ` <span class="qty">×${item.quantity}</span>` : "";
  const note = item.note && item.note.trim().length > 0
    ? `<span class="note">${esc(item.note.trim())}</span>`
    : "";
  const packedClass = item.status === "packed" ? " packed" : "";
  return `<li class="item${packedClass}">
    <span class="status" title="${esc(meta.label)}">${esc(meta.emoji)}</span>
    <span class="title">${esc(item.title)}${qty}${note}</span>
  </li>`;
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
