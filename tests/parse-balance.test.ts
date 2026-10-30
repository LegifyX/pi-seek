import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBalance, parseBalance } from "../src/config.ts";

const validPayload = () => ({
  balance_infos: [
    {
      currency: "USD",
      granted_balance: "0.00",
      topped_up_balance: "24.62",
      total_balance: "24.62",
    },
  ],
  is_available: true,
});

test("parseBalance: normalizes a valid payload", () => {
  assert.deepEqual(parseBalance(validPayload()), {
    entries: [
      {
        currency: "USD",
        grantedBalance: 0,
        toppedUpBalance: 24.62,
        totalBalance: 24.62,
      },
    ],
    isAvailable: true,
  });
});

test("parseBalance: a real zero balance is available", () => {
  const result = parseBalance({
    balance_infos: [
      {
        currency: "USD",
        granted_balance: "0",
        topped_up_balance: "0",
        total_balance: "0",
      },
    ],
    is_available: true,
  });
  assert.equal(result.isAvailable, true);
  assert.deepEqual(result.entries, [
    { currency: "USD", grantedBalance: 0, toppedUpBalance: 0, totalBalance: 0 },
  ]);
});

test("parseBalance: all-malformed entries are unavailable and list nothing", () => {
  const result = parseBalance({
    balance_infos: [
      {
        currency: "USD",
        granted_balance: "abc",
        topped_up_balance: "NaN",
        total_balance: undefined,
      },
    ],
    is_available: true,
  });
  assert.equal(result.isAvailable, false);
  assert.deepEqual(result.entries, []);
});

test("parseBalance: absent balance_infos is unavailable", () => {
  assert.equal(parseBalance({}).isAvailable, false);
  assert.equal(parseBalance(undefined).isAvailable, false);
  assert.equal(parseBalance(null).isAvailable, false);
  assert.equal(parseBalance("not an object").isAvailable, false);
  const empty = parseBalance({ balance_infos: [] });
  assert.equal(empty.isAvailable, false);
  assert.deepEqual(empty.entries, []);
});

test("parseBalance: injected NaN and Infinity never leak", () => {
  const result = parseBalance({
    balance_infos: [
      {
        currency: "USD",
        granted_balance: Number.NaN,
        topped_up_balance: Number.POSITIVE_INFINITY,
        total_balance: Number.NEGATIVE_INFINITY,
      },
    ],
    is_available: true,
  });
  assert.equal(result.isAvailable, false);
  assert.deepEqual(result.entries, []);
});

test("parseBalance: is_available false wins even with valid amounts", () => {
  const result = parseBalance({
    ...validPayload(),
    is_available: false,
  });
  assert.equal(result.isAvailable, false);
  assert.equal(result.entries[0]?.totalBalance, 24.62);
});

// The live account this extension was debugged against reports USD 0.00 first
// and the funded CNY entry second; keeping only one entry hid the real credit.
test("parseBalance: keeps every currency entry in the API's order", () => {
  const result = parseBalance({
    balance_infos: [
      {
        currency: "USD",
        granted_balance: "0.00",
        topped_up_balance: "0.00",
        total_balance: "0.00",
      },
      {
        currency: "CNY",
        granted_balance: "0.00",
        topped_up_balance: "39.22",
        total_balance: "39.22",
      },
    ],
    is_available: true,
  });
  assert.equal(result.isAvailable, true);
  assert.deepEqual(result.entries, [
    { currency: "USD", grantedBalance: 0, toppedUpBalance: 0, totalBalance: 0 },
    {
      currency: "CNY",
      grantedBalance: 0,
      toppedUpBalance: 39.22,
      totalBalance: 39.22,
    },
  ]);
});

test("parseBalance: negative finite amounts are preserved", () => {
  const result = parseBalance({
    balance_infos: [
      {
        currency: "USD",
        granted_balance: "-5.00",
        topped_up_balance: "-0.50",
        total_balance: "-5.50",
      },
    ],
    is_available: true,
  });
  assert.equal(result.isAvailable, true);
  assert.deepEqual(result.entries, [
    {
      currency: "USD",
      grantedBalance: -5,
      toppedUpBalance: -0.5,
      totalBalance: -5.5,
    },
  ]);
});

test("parseBalance: numeric fields are always finite", () => {
  const payloads = [
    undefined,
    {},
    { balance_infos: [] },
    { balance_infos: [{ currency: "USD" }] },
    { balance_infos: [{ currency: "USD", total_balance: "NaN" }] },
    {
      balance_infos: [
        { currency: "USD", total_balance: Number.POSITIVE_INFINITY },
      ],
    },
    { balance_infos: [{ currency: "USD", total_balance: "-12.5" }] },
  ];
  for (const payload of payloads) {
    const { entries } = parseBalance(payload);
    for (const entry of entries) {
      for (const field of [
        "grantedBalance",
        "toppedUpBalance",
        "totalBalance",
      ] as const) {
        assert.ok(
          Number.isFinite(entry[field]),
          `${field} must be finite for ${JSON.stringify(payload)}`
        );
      }
    }
  }
});

test("formatBalance: joins every entry and reports unavailable when empty", () => {
  assert.equal(formatBalance([]), "unavailable");
  assert.equal(
    formatBalance([
      {
        currency: "USD",
        grantedBalance: 0,
        toppedUpBalance: 0,
        totalBalance: 0,
      },
      {
        currency: "CNY",
        grantedBalance: 0,
        toppedUpBalance: 39.22,
        totalBalance: 39.22,
      },
    ]),
    "$0.00 · ¥39.22"
  );
  assert.equal(
    formatBalance([
      {
        currency: "EUR",
        grantedBalance: 0,
        toppedUpBalance: 1,
        totalBalance: 1,
      },
    ]),
    "EUR 1.00"
  );
});
