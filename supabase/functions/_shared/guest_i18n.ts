// guest_i18n.ts
//
// Every user-facing string of the public guest page (pa-guest-view), plus the
// Accept-Language negotiation that picks between them. Pure and
// side-effect-free so the whole table can be unit-tested without a server.
//
// WHOSE language? The guest's, read off their browser's Accept-Language
// header — not the language of whoever minted the link. The page is read by
// the guest, and the server has no idea what language the link's creator
// speaks: there is no locale column anywhere in the packalong schema, and the
// app never sends one. Accept-Language costs no migration and no app change.
//
// COVERAGE mirrors the Flutter app on purpose. The app ships 19 locales but
// only de and en are fully translated (1072 keys); the other 17 sit at
// ~603-678 and fall back to English for exactly the vocabulary this page needs
// — a French user already reads "Packed" / "Outbound" / "Luggage" in the app
// today. Translating this page further than the app would mean a guest reads
// "Emballé" in the browser and "Packed" ten minutes later in the app, for the
// same thing. So: de and en here, English for everyone else, same as the app.
// When the app's .arb files are filled in, this file follows — and then it is
// data, not code:
//
//   1. add the tag to Locale + SUPPORTED_LOCALES
//   2. add one entry to STRINGS (the Record type makes the compiler list every
//      key you still owe it)
//
// Nothing else in pa-guest-view needs touching. Wording for the statuses and
// the two pack directions is lifted verbatim from the app's app_<loc>.arb
// (itemStatus* / packDirection*) so the same thing is never called two names;
// that is also why German says "Zu besorgen" and not the "Zu kaufen" this page
// used to invent for itself.

/** Locales with a full translation below. Everyone else gets DEFAULT_LOCALE. */
export type Locale = "de" | "en";
export const SUPPORTED_LOCALES: Locale[] = ["de", "en"];
export const DEFAULT_LOCALE: Locale = "en";

/**
 * The five item statuses (packalong.items.status) and the two pack directions.
 * Emoji live in the page — they carry no language.
 */
export type StatusKey = "packed" | "toBuy" | "open" | "unclear" | "planning";

export type Strings = {
  /** Value for <html lang="…">. */
  htmlLang: string;
  /** Locale tag for Intl date formatting and localeCompare sorting. */
  intlLocale: string;
  pageTitle: string;

  // Error pages (rendered as HTML, plain text in, escaped by the page).
  errMethodTitle: string;
  errMethodBody: string;
  errRateTitle: string;
  errRateBody: string;
  errUnavailableTitle: string;
  errUnavailableBody: string;
  errNoTokenTitle: string;
  errNoTokenBody: string;
  errNotFoundTitle: string;
  errNotFoundBody: string;
  errRevokedTitle: string;
  errRevokedBody: string;
  errExpiredTitle: string;
  errExpiredBody: string;
  errGoneTitle: string;
  errGoneBody: string;
  errGenericTitle: string;
  errGenericBody: string;

  // Save path (JSON bodies — plain text, never escaped, never markup).
  saveRateLimited: string;
  saveNotConfigured: string;
  saveBadRequest: string;
  saveNoToken: string;
  saveTooMany: string;
  saveUnknownStatus: string;
  saveTripGone: string;
  saveWindowClosed: string;
  saveFailed: string;

  // Page chrome.
  guestFallbackName: string;
  tripFallbackTitle: string;
  /** Takes ALREADY-ESCAPED html for the name — hence the Html suffix. */
  packListForHtml: (nameHtml: string) => string;
  progressOutbound: (done: number, total: number) => string;
  progressReturn: (done: number, total: number) => string;
  emptyList: (name: string) => string;
  noContainer: string;
  noCategory: string;
  dateFrom: (date: string) => string;
  dateUntil: (date: string) => string;

  // Directions.
  tabsAriaLabel: string;
  dirOutbound: string;
  dirReturn: string;
  hintReadOnlyOutbound: string;
  hintReadOnlyReturn: string;
  hintEditOutbound: string;
  hintEditReturn: string;

  // Items.
  statuses: Record<StatusKey, string>;
  returnToggleLabel: string;
  returnPackedYes: string;
  returnPackedNo: string;
  statusAria: (title: string) => string;
  returnAria: (title: string) => string;

  // Save bar. The count is rendered by the page's inline script, not here, so
  // these two are data the script embeds rather than a function it cannot
  // receive: `changeCountOther` carries a literal {n} for the script to fill.
  // A language needing more than two plural forms (Polish, Russian, …) will
  // want Intl.PluralRules and a category map here — worth doing when the first
  // such locale actually arrives, not before.
  saveButton: string;
  saveInProgress: string;
  saveGenericFail: string;
  changeCountOne: string;
  changeCountOther: string;

  // Join / download block.
  joinCta: string;
  /** Takes ALREADY-ESCAPED html for the masked address. */
  joinHintHtml: (maskedEmailHtml: string) => string;
  joinFallback: string;
  downloadCta: string;
  viewOnlyCta: string;

  // Footer. Takes ALREADY-ESCAPED html for the mailto link.
  reportHtml: (linkHtml: string) => string;
  reportLinkLabel: string;
};

const de: Strings = {
  htmlLang: "de",
  intlLocale: "de-DE",
  pageTitle: "PackAlong – Gastansicht",

  errMethodTitle: "Nicht erlaubt",
  errMethodBody: "Diese Seite wird nur per Aufruf im Browser angezeigt.",
  errRateTitle: "Zu viele Anfragen",
  errRateBody: "Bitte versuche es in einer Minute erneut.",
  errUnavailableTitle: "Nicht verfügbar",
  errUnavailableBody: "Der Server ist nicht korrekt konfiguriert.",
  errNoTokenTitle: "Link unvollständig",
  errNoTokenBody: "Dieser Link enthält kein Token.",
  errNotFoundTitle: "Nicht gefunden",
  errNotFoundBody: "Dieser Link ist ungültig.",
  errRevokedTitle: "Zurückgezogen",
  errRevokedBody: "Dieser Freigabelink wurde zurückgezogen.",
  errExpiredTitle: "Abgelaufen",
  errExpiredBody: "Dieser Freigabelink ist abgelaufen. Bitte frage nach einem neuen.",
  errGoneTitle: "Nicht mehr verfügbar",
  errGoneBody: "Diese Reise oder dieser Gast existiert nicht mehr.",
  errGenericTitle: "Etwas ist schiefgelaufen",
  errGenericBody:
    "Diese Seite konnte gerade nicht geladen werden. Bitte versuche es später erneut.",

  saveRateLimited: "Zu viele Anfragen. Bitte kurz warten.",
  saveNotConfigured: "Der Server ist nicht korrekt konfiguriert.",
  saveBadRequest: "Ungültige Anfrage.",
  saveNoToken: "Dieser Link enthält kein Token.",
  saveTooMany: "Zu viele Änderungen auf einmal.",
  saveUnknownStatus: "Unbekannter Status.",
  saveTripGone: "Diese Reise existiert nicht mehr.",
  saveWindowClosed: "Die Reise ist vorbei — die Liste kann nicht mehr geändert werden.",
  saveFailed: "Das Speichern hat gerade nicht geklappt. Bitte später erneut versuchen.",

  guestFallbackName: "Gast",
  tripFallbackTitle: "Reise",
  packListForHtml: (nameHtml) => `Packliste für <strong>${nameHtml}</strong>`,
  progressOutbound: (done, total) => `${done} von ${total} gepackt`,
  progressReturn: (done, total) => `${done} von ${total} wieder eingepackt`,
  emptyList: (name) => `Für ${name} sind auf dieser Reise noch keine Sachen eingetragen.`,
  noContainer: "Ohne Behälter",
  noCategory: "Sonstiges",
  dateFrom: (date) => `ab ${date}`,
  dateUntil: (date) => `bis ${date}`,

  tabsAriaLabel: "Packrichtung",
  dirOutbound: "Hinpacken",
  dirReturn: "Rückpacken",
  hintReadOnlyOutbound: "Diese Ansicht ist nur zum Anschauen.",
  hintReadOnlyReturn: "Was für die Heimreise wieder eingepackt wurde. Nur zum Anschauen.",
  hintEditOutbound: "Du kannst den Status deiner Sachen ändern. Zum Übernehmen unten speichern.",
  hintEditReturn:
    "Hier hakst du ab, was für die Heimreise wieder eingepackt ist. Zum Übernehmen unten speichern.",

  statuses: {
    packed: "Gepackt",
    toBuy: "Zu besorgen",
    open: "Offen",
    unclear: "Unklar",
    planning: "In Planung",
  },
  returnToggleLabel: "Eingepackt",
  returnPackedYes: "Wieder eingepackt",
  returnPackedNo: "Noch nicht wieder eingepackt",
  statusAria: (title) => `Status von ${title}`,
  returnAria: (title) => `${title} für die Heimreise eingepackt`,

  saveButton: "Speichern",
  saveInProgress: "Wird gespeichert …",
  saveGenericFail: "Speichern fehlgeschlagen.",
  changeCountOne: "1 Änderung",
  changeCountOther: "{n} Änderungen",

  joinCta: "App holen & beitreten",
  joinHintHtml: (email) => `Zum Beitreten mit ${email} registrieren oder anmelden.`,
  joinFallback: "App noch nicht installiert? Hier laden.",
  downloadCta: "App laden",
  viewOnlyCta: "Diese Ansicht ist nur zum Anschauen. Für einen eigenen Zugang bitte die App laden.",

  reportHtml: (linkHtml) =>
    `Missbrauch oder unangemessene Inhalte? ${linkHtml}. Nutzung unterliegt der EULA; gemeldete Inhalte werden geprüft.`,
  reportLinkLabel: "Melden",
};

const en: Strings = {
  htmlLang: "en",
  intlLocale: "en-GB",
  pageTitle: "PackAlong – Guest view",

  errMethodTitle: "Not allowed",
  errMethodBody: "This page is only shown when opened in a browser.",
  errRateTitle: "Too many requests",
  errRateBody: "Please try again in a minute.",
  errUnavailableTitle: "Unavailable",
  errUnavailableBody: "The server is not configured correctly.",
  errNoTokenTitle: "Incomplete link",
  errNoTokenBody: "This link carries no token.",
  errNotFoundTitle: "Not found",
  errNotFoundBody: "This link is not valid.",
  errRevokedTitle: "Revoked",
  errRevokedBody: "This share link has been revoked.",
  errExpiredTitle: "Expired",
  errExpiredBody: "This share link has expired. Please ask for a new one.",
  errGoneTitle: "No longer available",
  errGoneBody: "This trip or this guest no longer exists.",
  errGenericTitle: "Something went wrong",
  errGenericBody: "This page could not be loaded just now. Please try again later.",

  saveRateLimited: "Too many requests. Please wait a moment.",
  saveNotConfigured: "The server is not configured correctly.",
  saveBadRequest: "Invalid request.",
  saveNoToken: "This link carries no token.",
  saveTooMany: "Too many changes at once.",
  saveUnknownStatus: "Unknown status.",
  saveTripGone: "This trip no longer exists.",
  saveWindowClosed: "The trip is over — the list can no longer be changed.",
  saveFailed: "Saving didn't work just now. Please try again later.",

  guestFallbackName: "Guest",
  tripFallbackTitle: "Trip",
  packListForHtml: (nameHtml) => `Packing list for <strong>${nameHtml}</strong>`,
  progressOutbound: (done, total) => `${done} of ${total} packed`,
  progressReturn: (done, total) => `${done} of ${total} packed again`,
  emptyList: (name) => `Nothing has been added for ${name} on this trip yet.`,
  noContainer: "No luggage",
  noCategory: "Other",
  dateFrom: (date) => `from ${date}`,
  dateUntil: (date) => `until ${date}`,

  tabsAriaLabel: "Pack direction",
  dirOutbound: "Outbound",
  dirReturn: "Return",
  hintReadOnlyOutbound: "This view is read-only.",
  hintReadOnlyReturn: "What was packed again for the way home. Read-only.",
  hintEditOutbound: "You can change the status of your things. Save below to apply.",
  hintEditReturn: "Tick off what is packed again for the way home. Save below to apply.",

  statuses: {
    packed: "Packed",
    toBuy: "To get",
    open: "Open",
    unclear: "Unclear",
    planning: "Planning",
  },
  returnToggleLabel: "Packed",
  returnPackedYes: "Packed again",
  returnPackedNo: "Not packed again yet",
  statusAria: (title) => `Status of ${title}`,
  returnAria: (title) => `${title} packed for the way home`,

  saveButton: "Save",
  saveInProgress: "Saving …",
  saveGenericFail: "Saving failed.",
  changeCountOne: "1 change",
  changeCountOther: "{n} changes",

  joinCta: "Get the app & join",
  joinHintHtml: (email) => `To join, sign up or sign in with ${email}.`,
  joinFallback: "App not installed yet? Get it here.",
  downloadCta: "Get the app",
  viewOnlyCta: "This view is read-only. For your own access, please get the app.",

  reportHtml: (linkHtml) =>
    `Abuse or inappropriate content? ${linkHtml}. Use is subject to the EULA; reported content will be reviewed.`,
  reportLinkLabel: "Report",
};

/** The Record type is the completeness check: a new locale must fill every key. */
export const STRINGS: Record<Locale, Strings> = { de, en };

export function stringsFor(locale: Locale): Strings {
  return STRINGS[locale];
}

/**
 * Pick the best supported locale for an Accept-Language header.
 *
 * Real negotiation, not a prefix peek: a browser sending
 * `fr-FR,fr;q=0.9,de;q=0.8,en;q=0.7` wants French, then German, then English.
 * We have no French, so the honest answer is German (q=0.8) — the highest-
 * ranked thing we can actually speak — and NOT English just because English is
 * the default. Ties keep the order the header listed them in.
 *
 * `de-AT` and `de-CH` match `de` on the primary subtag. `*` is ignored: it
 * means "anything", which the default already covers. Anything unparseable or
 * absent yields DEFAULT_LOCALE.
 */
export function negotiateLocale(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const candidates: { tag: string; q: number; order: number }[] = [];
  acceptLanguage.split(",").forEach((part, order) => {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag.trim().toLowerCase();
    if (!tag || tag === "*") return;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match) {
        const parsed = Number.parseFloat(match[1]);
        // A malformed q is not a reason to drop a language the guest asked
        // for; treat it as unweighted.
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    // q=0 means "explicitly not this one".
    if (q <= 0) return;
    candidates.push({ tag, q, order });
  });

  candidates.sort((a, b) => (b.q - a.q) || (a.order - b.order));
  for (const candidate of candidates) {
    const primary = candidate.tag.split("-")[0];
    const hit = SUPPORTED_LOCALES.find((locale) => locale === primary);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}
