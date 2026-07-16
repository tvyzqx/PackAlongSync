// edit_window.ts
//
// Pure, side-effect-free decision logic for how long a guest-share link stays
// editable (Issue #1 guest-view follow-up). Kept separate from the
// pa-guest-view handler so the rule can be unit-tested against DST edges and
// so both the page render and the save path answer the question the same way.
//
// The rule, in one sentence: a guest may set the status of their own items
// until the END of the trip's start day, inclusive, in EDIT_TIMEZONE — and a
// trip without a start_date has no cutoff at all.
//
// Why inclusive-to-end-of-day: the packing happens ON the departure day, so
// cutting off at the start_date instant (often midnight, or whatever time the
// owner happened to pick) would close the page exactly when the guest needs
// it. Once the trip is under way the list becomes a record of what was packed
// and freezes; the page keeps serving that read-only view past end_date until
// expires_at or a revoke closes it.

/**
 * The trip's start day is "over" at midnight in this zone. The product is
 * German-facing and trips.start_date is a timestamptz, so an absolute instant
 * needs a zone to be turned back into a calendar day the guest recognises.
 */
export const EDIT_TIMEZONE = "Europe/Berlin";

/**
 * True while the guest may still edit: no start date at all, or the start day
 * has not yet ended in [timeZone].
 *
 * [startDate] is the trip's start_date as stored (an ISO timestamptz) or null.
 * [now] defaults to the current instant; tests pass it explicitly.
 *
 * An unparseable start_date falls open rather than shut: the cutoff is a
 * convenience, not a security boundary (the token's scope is), so bad data
 * should not silently strand a guest.
 */
export function withinEditWindow(
  startDate: string | null,
  now: Date = new Date(),
  timeZone: string = EDIT_TIMEZONE,
): boolean {
  if (!startDate) return true;
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return true;
  return now.getTime() <= endOfDayUtcMs(start, timeZone);
}

/**
 * The last instant of the calendar day that [instant] falls on in [timeZone]
 * — i.e. one millisecond before the following local midnight.
 */
export function endOfDayUtcMs(instant: Date, timeZone: string): number {
  const { year, month, day } = localParts(instant, timeZone);
  return localMidnightUtcMs(year, month, day + 1, timeZone) - 1;
}

/** The wall-clock date/time [instant] shows in [timeZone]. */
function localParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** How far [timeZone] runs ahead of UTC at [instant], in milliseconds. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

/**
 * The instant local midnight opens on the given calendar day. Date.UTC gives
 * the naive wall clock; subtracting the zone offset turns it into a real
 * instant. The offset has to be read AT that instant, not at some reference
 * point, so the first guess is refined once — otherwise the two DST days a
 * year land an hour off. Day overflow (day = 32) normalises through Date.UTC.
 */
function localMidnightUtcMs(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day);
  const guess = naive - offsetMsAt(new Date(naive), timeZone);
  return naive - offsetMsAt(new Date(guess), timeZone);
}
