// Tests for the guest-view edit window (Issue #1 guest-view follow-up).
//
// Run:  deno test supabase/functions/_shared/edit_window.test.ts
//
// The rule under test: editable until the end of the trip's start day,
// inclusive, in Europe/Berlin. The interesting cases are the boundary
// (midnight local, NOT midnight UTC) and the two DST days a year, where a
// naive fixed-offset calculation lands an hour off.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { endOfDayUtcMs, withinEditWindow } from "./edit_window.ts";

const BERLIN = "Europe/Berlin";

Deno.test("no start date -> always editable", () => {
  assertEquals(withinEditWindow(null, new Date("2030-01-01T00:00:00Z")), true);
});

Deno.test("unparseable start date -> falls open, not shut", () => {
  assertEquals(withinEditWindow("not-a-date", new Date("2030-01-01T00:00:00Z")), true);
});

Deno.test("well before the trip -> editable", () => {
  assertEquals(
    withinEditWindow("2026-08-01T00:00:00+02:00", new Date("2026-07-16T12:00:00Z")),
    true,
  );
});

Deno.test("the start day itself is editable, including its last local hour", () => {
  // 23:30 Berlin on the start day = 21:30Z (CEST, +2).
  assertEquals(
    withinEditWindow("2026-08-01T00:00:00+02:00", new Date("2026-08-01T21:30:00Z")),
    true,
  );
});

Deno.test("start_date carrying a time of day does not cut the day short", () => {
  // Owner picked 09:00 local; packing at 18:00 local must still work.
  assertEquals(
    withinEditWindow("2026-08-01T09:00:00+02:00", new Date("2026-08-01T16:00:00Z")),
    true,
  );
});

Deno.test("closes at local midnight, not UTC midnight", () => {
  // 22:30Z is already 00:30 on Aug 2 in Berlin -> shut. A UTC-midnight
  // cutoff would still call this open.
  assertEquals(
    withinEditWindow("2026-08-01T00:00:00+02:00", new Date("2026-08-01T22:30:00Z")),
    false,
  );
});

Deno.test("day after the start day -> read-only", () => {
  assertEquals(
    withinEditWindow("2026-08-01T00:00:00+02:00", new Date("2026-08-02T08:00:00Z")),
    false,
  );
});

Deno.test("boundary is exact to the millisecond", () => {
  const start = "2026-08-01T00:00:00+02:00";
  // Aug 1 ends at 2026-08-01T21:59:59.999Z (00:00 Aug 2 Berlin, CEST +2).
  const lastMs = Date.UTC(2026, 7, 1, 21, 59, 59, 999);
  assertEquals(endOfDayUtcMs(new Date(start), BERLIN), lastMs);
  assertEquals(withinEditWindow(start, new Date(lastMs)), true);
  assertEquals(withinEditWindow(start, new Date(lastMs + 1)), false);
});

Deno.test("DST end: the 25-hour day ends at the right instant", () => {
  // 2026-10-25 Berlin: clocks go back at 03:00 CEST -> 02:00 CET, making it a
  // 25-hour day that runs 2026-10-24T22:00Z .. 2026-10-25T23:00Z. Reading the
  // offset at the start instant (+2, still CEST) instead of at the closing
  // midnight (+1, already CET) would land an hour early and shut the page at
  // 22:00Z, while the guest's clock still said 23:00 on the start day.
  const start = "2026-10-25T00:00:00+02:00";
  assertEquals(endOfDayUtcMs(new Date(start), BERLIN), Date.UTC(2026, 9, 25, 22, 59, 59, 999));
  assertEquals(withinEditWindow(start, new Date("2026-10-25T22:30:00Z")), true);
  assertEquals(withinEditWindow(start, new Date("2026-10-25T23:30:00Z")), false);
});

Deno.test("DST start: the 23-hour day ends at the right instant", () => {
  // 2026-03-29 Berlin: clocks jump 02:00 CET -> 03:00 CEST. The day ends at
  // 00:00 Mar 30 CEST = 2026-03-29T22:00Z.
  const start = "2026-03-29T00:00:00+01:00";
  assertEquals(endOfDayUtcMs(new Date(start), BERLIN), Date.UTC(2026, 2, 29, 21, 59, 59, 999));
  assertEquals(withinEditWindow(start, new Date("2026-03-29T21:30:00Z")), true);
  assertEquals(withinEditWindow(start, new Date("2026-03-29T22:30:00Z")), false);
});

Deno.test("month and year rollover normalise", () => {
  const nye = "2026-12-31T00:00:00+01:00";
  // Dec 31 ends at 00:00 Jan 1 2027 CET = 2026-12-31T23:00Z.
  assertEquals(endOfDayUtcMs(new Date(nye), BERLIN), Date.UTC(2026, 11, 31, 22, 59, 59, 999));
  assertEquals(withinEditWindow(nye, new Date("2026-12-31T22:30:00Z")), true);
  assertEquals(withinEditWindow(nye, new Date("2027-01-01T00:30:00Z")), false);
});
