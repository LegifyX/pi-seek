// DeepSeek bills on a fixed UTC+8 calendar: peak Mon-Fri 09:00-12:00 and
// 14:00-18:00, off-peak at 50% of peak, weekends off-peak since 2026-08-23.
// Rule and edge cases ported from pi-peak-hours (src/schedules.ts,
// src/windows.ts), verified there 2026-08-28 against
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

// Shown by the balance card so the token in the footer has an explanation.
export const PEAK_RULE_NOTE =
  "peak Mon-Fri 09:00-12:00, 14:00-18:00 UTC+8 · off-peak 50%";

const isoWeekday = (instant: Date): number => {
  const day = instant.getUTCDay();
  return day === 0 ? 7 : day;
};

export const isPeak = (instant: Date = new Date()): boolean => {
  const billing = new Date(
    instant.getTime() + CALENDAR_OFFSET_MINUTES * MINUTE_MS
  );
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
    : `off-peak ${OFF_PEAK_PERCENT}% until ${clockTime(nextPeakStart(instant))}`;

const clockTime = (instant: Date): string => {
  const billing = new Date(
    instant.getTime() + CALENDAR_OFFSET_MINUTES * MINUTE_MS
  );
  const hours = String(billing.getUTCHours()).padStart(2, "0");
  const minutes = String(billing.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
};

// First whole minute that bills at the peak rate. Stepping through isPeak keeps
// the answer in sync with the classification rule above by construction; the
// worst gap (Friday 18:00 to Monday 09:00) is 4320 steps.
const nextPeakStart = (instant: Date): Date => {
  const from = Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS;
  for (const step of Array.from({ length: 10 * 24 * 60 }, (_, i) => i + 1)) {
    const candidate = new Date(from + step * MINUTE_MS);
    if (isPeak(candidate)) {
      return candidate;
    }
  }
  return new Date(from);
};
