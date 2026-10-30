import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPhase, isPeak, PEAK_RULE_NOTE } from "../src/peak.ts";

// Billing wall time is UTC+8, so 09:00 there is 01:00Z and 18:00 there is
// 10:00Z. 2026-09-04 is a Friday, 2026-09-05 a Saturday, 2026-09-07 a Monday,
// all after the 2026-08-22T16:00Z weekend change.
const at = (instant: string): Date => new Date(instant);

const MORNING_WINDOW = /09:00-12:00/;
const AFTERNOON_WINDOW = /14:00-18:00/;
const OFF_PEAK_TOKEN = /off-peak 50%/;

test("isPeak: Friday inside both windows is peak", () => {
  assert.equal(isPeak(at("2026-09-04T01:00:00Z")), true); // 09:00 local
  assert.equal(isPeak(at("2026-09-04T03:59:59Z")), true); // 11:59:59 local
  assert.equal(isPeak(at("2026-09-04T06:00:00Z")), true); // 14:00 local
  assert.equal(isPeak(at("2026-09-04T09:59:59Z")), true); // 17:59:59 local
});

test("isPeak: the lunch break and the evening are off-peak", () => {
  assert.equal(isPeak(at("2026-09-04T04:00:00Z")), false); // 12:00 local
  assert.equal(isPeak(at("2026-09-04T05:59:59Z")), false); // 13:59:59 local
  assert.equal(isPeak(at("2026-09-04T10:00:00Z")), false); // 18:00 local
});

test("isPeak: weekends are off-peak all day", () => {
  assert.equal(isPeak(at("2026-09-05T02:00:00Z")), false); // Sat 10:00 local
  assert.equal(isPeak(at("2026-09-06T07:00:00Z")), false); // Sun 15:00 local
});

test("isPeak: Monday morning resumes peak", () => {
  assert.equal(isPeak(at("2026-09-07T01:00:00Z")), true); // 09:00 local
  assert.equal(isPeak(at("2026-09-07T00:59:59Z")), false); // 08:59:59 local
});

// The weekday and the hour are both read on the billing calendar: Wednesday
// 00:30Z is 08:30 in UTC+8, which is still off-peak.
test("isPeak: the phase follows the UTC+8 calendar, not UTC", () => {
  assert.equal(isPeak(at("2026-09-09T00:30:00Z")), false);
  assert.equal(isPeak(at("2026-09-09T01:00:00Z")), true);
});

test("formatPhase: renders the footer token", () => {
  assert.equal(formatPhase(at("2026-09-04T02:00:00Z")), "peak");
  assert.equal(
    formatPhase(at("2026-09-04T10:00:00Z")),
    "off-peak 50% until 09:00"
  );
});

// 04:30Z is 12:30 in UTC+8: the gap between the two windows, so the wait is the
// 14:00 window rather than the next weekday morning.
test("formatPhase: the off-peak end is the next window on the billing calendar", () => {
  assert.equal(
    formatPhase(at("2026-09-04T04:30:00Z")),
    "off-peak 50% until 14:00"
  );
  assert.equal(
    formatPhase(at("2026-09-05T04:00:00Z")),
    "off-peak 50% until 09:00"
  );
});

test("PEAK_RULE_NOTE explains the token shown in the footer", () => {
  assert.match(PEAK_RULE_NOTE, MORNING_WINDOW);
  assert.match(PEAK_RULE_NOTE, AFTERNOON_WINDOW);
  assert.match(PEAK_RULE_NOTE, OFF_PEAK_TOKEN);
});
