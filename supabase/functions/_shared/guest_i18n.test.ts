// Tests for the guest page's language negotiation.
//
// Run:  deno test supabase/functions/_shared/guest_i18n.test.ts
//
// The interesting part is q-value handling: the guest's most-preferred
// language that we ACTUALLY speak should win, which is not the same as "first
// tag in the header" nor "default unless the first tag matches".

import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_LOCALE,
  negotiateLocale,
  STRINGS,
  stringsFor,
  SUPPORTED_LOCALES,
} from "./guest_i18n.ts";

Deno.test("no header -> default", () => {
  assertEquals(negotiateLocale(null), "en");
  assertEquals(negotiateLocale(""), "en");
});

Deno.test("plain tags", () => {
  assertEquals(negotiateLocale("de"), "de");
  assertEquals(negotiateLocale("en"), "en");
});

Deno.test("regional variants match on the primary subtag", () => {
  assertEquals(negotiateLocale("de-AT"), "de");
  assertEquals(negotiateLocale("de-CH"), "de");
  assertEquals(negotiateLocale("en-US"), "en");
});

Deno.test("case is irrelevant", () => {
  assertEquals(negotiateLocale("DE-de"), "de");
});

Deno.test("a language we don't speak falls back to the default", () => {
  assertEquals(negotiateLocale("fr-FR,fr;q=0.9"), "en");
  assertEquals(negotiateLocale("ja"), "en");
});

Deno.test("the best language we DO speak wins, not the default", () => {
  // The French speaker who also reads German: we have no French, so German at
  // q=0.8 beats English at q=0.7. Falling back to English here would ignore a
  // preference the guest explicitly stated.
  assertEquals(negotiateLocale("fr-FR,fr;q=0.9,de;q=0.8,en;q=0.7"), "de");
});

Deno.test("q ordering beats header ordering", () => {
  assertEquals(negotiateLocale("en;q=0.5,de;q=0.9"), "de");
  assertEquals(negotiateLocale("de;q=0.3,en;q=0.9"), "en");
});

Deno.test("equal q keeps the order the header listed", () => {
  assertEquals(negotiateLocale("de;q=0.8,en;q=0.8"), "de");
  assertEquals(negotiateLocale("en;q=0.8,de;q=0.8"), "en");
});

Deno.test("a tag with no q outranks an explicitly weighted one", () => {
  // No q means q=1.
  assertEquals(negotiateLocale("de,en;q=0.9"), "de");
  assertEquals(negotiateLocale("en,de;q=0.9"), "en");
});

Deno.test("q=0 means 'not this one'", () => {
  assertEquals(negotiateLocale("de;q=0,en;q=0.5"), "en");
  // Everything refused -> default.
  assertEquals(negotiateLocale("de;q=0,en;q=0"), "en");
});

Deno.test("wildcard is ignored in favour of the default", () => {
  assertEquals(negotiateLocale("*"), "en");
  assertEquals(negotiateLocale("fr,*;q=0.5"), "en");
  // A real match still beats the wildcard.
  assertEquals(negotiateLocale("*;q=0.9,de;q=0.8"), "de");
});

Deno.test("junk does not throw and does not strand the guest", () => {
  assertEquals(negotiateLocale(";;;"), "en");
  assertEquals(negotiateLocale("de;q=abc"), "de");
  assertEquals(negotiateLocale("   "), "en");
});

Deno.test("whitespace around tags and params is tolerated", () => {
  assertEquals(negotiateLocale(" de ; q = 0.9 , en ; q = 0.8 "), "de");
});

Deno.test("every supported locale has a full string table", () => {
  // The Record<Locale, Strings> type enforces this at compile time; this
  // guards the runtime shape too — a missing key would surface as undefined
  // in the page rather than a build error.
  for (const locale of SUPPORTED_LOCALES) {
    const s = stringsFor(locale);
    assertExists(s, `no strings for ${locale}`);
    for (const [key, value] of Object.entries(s)) {
      assertExists(value, `${locale}.${key} is missing`);
      if (typeof value === "string") {
        assertEquals(value.length > 0, true, `${locale}.${key} is empty`);
      }
    }
  }
});

Deno.test("every locale covers all five item statuses", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const { statuses } = stringsFor(locale);
    for (const key of ["packed", "toBuy", "open", "unclear", "planning"] as const) {
      assertExists(statuses[key], `${locale}.statuses.${key} is missing`);
    }
  }
});

Deno.test("the default locale is itself supported", () => {
  assertEquals(SUPPORTED_LOCALES.includes(DEFAULT_LOCALE), true);
  assertEquals(Object.keys(STRINGS).sort(), [...SUPPORTED_LOCALES].sort());
});

Deno.test("plural forms differ where the language needs them to", () => {
  assertEquals(stringsFor("de").changeCountOne, "1 Änderung");
  assertEquals(stringsFor("en").changeCountOne, "1 change");
  // The page's inline script does this substitution; if the placeholder ever
  // drifts, the save bar would read a literal "{n}".
  for (const locale of SUPPORTED_LOCALES) {
    const other = stringsFor(locale).changeCountOther;
    assertEquals(other.includes("{n}"), true, `${locale}.changeCountOther lost its {n}`);
    assertEquals(other.replace("{n}", "3").includes("{n}"), false);
  }
  assertEquals(stringsFor("de").changeCountOther.replace("{n}", "3"), "3 Änderungen");
  assertEquals(stringsFor("en").changeCountOther.replace("{n}", "3"), "3 changes");
});

Deno.test("status wording matches the app's arb, not this page's old invention", () => {
  // The page used to say "Zu kaufen"/"Planung"; app_de.arb says these.
  assertEquals(stringsFor("de").statuses.toBuy, "Zu besorgen");
  assertEquals(stringsFor("de").statuses.planning, "In Planung");
  assertEquals(stringsFor("de").dirOutbound, "Hinpacken");
  assertEquals(stringsFor("de").dirReturn, "Rückpacken");
  assertEquals(stringsFor("en").statuses.toBuy, "To get");
  assertEquals(stringsFor("en").dirOutbound, "Outbound");
});
