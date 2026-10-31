// DeepSeek bills on a fixed UTC+8 calendar: peak Mon-Fri 09:00-12:00 and
// 14:00-18:00, off-peak at 50% of peak, weekends off-peak since 2026-08-23, and
// Chinese statutory holidays off-peak all day. Rule and edge cases ported from
// pi-peak-hours (src/schedules.ts, src/windows.ts), verified 2026-10-31 against
// https://api-docs.deepseek.com/quick_start/pricing/ : the weekday is read on
// the billing calendar, not UTC, and the weekend rule is gated on the instant
// being classified rather than on "now".
const CALENDAR_OFFSET_MINUTES = 8 * 60;
const MINUTE_MS = 60_000;
const OFF_PEAK_PERCENT = 50;
const PEAK_WEEKDAYS = [1, 2, 3, 4, 5]; // ISO, on the billing calendar
const PEAK_WINDOWS = [
  { end: 12 * 60, start: 9 * 60 },
  { end: 18 * 60, start: 14 * 60 },
];
const WEEKEND_OFF_PEAK_FROM = Date.parse("2026-08-22T16:00:00Z");
// The longest statutory break (Spring Festival 2026 runs 9 days) plus the wait
// for the next window; the scan below is a linear walk, so this is also its cap.
const MAX_PHASE_SCAN_MINUTES = 15 * 24 * 60;

// Shown by the balance card so the token in the footer has an explanation.
export const PEAK_RULE_NOTE =
  "peak Mon-Fri 09:00-12:00, 14:00-18:00 UTC+8 · off-peak 50% · holidays off-peak";

// Billing-calendar dates billed off-peak all day. Empty until a calendar is
// loaded, which classifies exactly like "no holiday known".
let holidayDates: ReadonlySet<string> = new Set();

export const setHolidayDates = (dates: Iterable<string>): void => {
  holidayDates = new Set(dates);
};

export const holidayDateCount = (): number => holidayDates.size;

const isoWeekday = (instant: Date): number => {
  const day = instant.getUTCDay();
  return day === 0 ? 7 : day;
};

// A Date whose UTC fields hold the billing calendar (UTC+8) wall clock.
const billingClock = (instant: Date): Date =>
  new Date(instant.getTime() + CALENDAR_OFFSET_MINUTES * MINUTE_MS);

const billingDateKey = (billing: Date): string =>
  billing.toISOString().slice(0, 10);

export const isPeak = (instant: Date = new Date()): boolean => {
  const billing = billingClock(instant);
  if (holidayDates.has(billingDateKey(billing))) {
    return false;
  }
  const weekday = isoWeekday(billing);
  if (
    instant.getTime() >= WEEKEND_OFF_PEAK_FROM &&
    !PEAK_WEEKDAYS.includes(weekday)
  ) {
    return false;
  }
  const seconds =
    billing.getUTCHours() * 3600 +
    billing.getUTCMinutes() * 60 +
    billing.getUTCSeconds();
  return PEAK_WINDOWS.some(
    ({ end, start }) => start * 60 <= seconds && seconds < end * 60
  );
};

// Footer token: "peak" or "off-peak 50% until HH:mm". The clock is read on the
// billing calendar, so it matches the times in the pricing doc rather than the
// user's timezone.
export const formatPhase = (instant: Date = new Date()): string =>
  isPeak(instant)
    ? "peak"
    : `off-peak ${OFF_PEAK_PERCENT}% until ${clockTime(nextPhaseChange(instant))}`;

const clockTime = (instant: Date): string => {
  const billing = billingClock(instant);
  const hours = String(billing.getUTCHours()).padStart(2, "0");
  const minutes = String(billing.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
};

// First whole minute that classifies differently, i.e. the instant the footer
// token goes stale. Emptying the scan on isPeak keeps it in sync with the
// classification rule by construction; the worst gap is a 9-day holiday run.
export const nextPhaseChange = (instant: Date = new Date()): Date => {
  const from = Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS;
  const current = isPeak(instant);
  for (let step = 1; step <= MAX_PHASE_SCAN_MINUTES; step += 1) {
    const candidate = new Date(from + step * MINUTE_MS);
    if (isPeak(candidate) !== current) {
      return candidate;
    }
  }
  return new Date(from + MINUTE_MS);
};

// First whole minute that bills at the peak rate.
export const nextPeakStart = (instant: Date): Date => {
  const from = Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS;
  for (let step = 1; step <= MAX_PHASE_SCAN_MINUTES; step += 1) {
    const candidate = new Date(from + step * MINUTE_MS);
    if (isPeak(candidate)) {
      return candidate;
    }
  }
  return new Date(from);
};
