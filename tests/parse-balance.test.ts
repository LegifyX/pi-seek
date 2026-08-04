import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBalance } from "../src/config.ts";

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
    currency: "USD",
    grantedBalance: 0,
    isAvailable: true,
    toppedUpBalance: 24.62,
    totalBalance: 24.62,
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
  assert.equal(result.grantedBalance, 0);
  assert.equal(result.toppedUpBalance, 0);
  assert.equal(result.totalBalance, 0);
});

test("parseBalance: all-malformed entries are unavailable but still zero", () => {
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
  assert.equal(result.grantedBalance, 0);
  assert.equal(result.toppedUpBalance, 0);
  assert.equal(result.totalBalance, 0);
});

test("parseBalance: absent balance_infos is unavailable", () => {
  assert.equal(parseBalance({}).isAvailable, false);
  assert.equal(parseBalance(undefined).isAvailable, false);
  assert.equal(parseBalance(null).isAvailable, false);
  assert.equal(parseBalance("not an object").isAvailable, false);
  const empty = parseBalance({ balance_infos: [] });
  assert.equal(empty.isAvailable, false);
  assert.equal(empty.currency, "USD");
  assert.equal(empty.totalBalance, 0);
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
  assert.equal(result.grantedBalance, 0);
  assert.equal(result.toppedUpBalance, 0);
  assert.equal(result.totalBalance, 0);
});

test("parseBalance: is_available false wins even with valid amounts", () => {
  const result = parseBalance({
    ...validPayload(),
    is_available: false,
  });
  assert.equal(result.isAvailable, false);
  assert.equal(result.totalBalance, 24.62);
});

test("parseBalance: prefers USD over other currencies", () => {
  const result = parseBalance({
    balance_infos: [
      {
        currency: "CNY",
        granted_balance: "0.00",
        topped_up_balance: "100.00",
        total_balance: "100.00",
      },
      {
        currency: "USD",
        granted_balance: "1.00",
        topped_up_balance: "10.00",
        total_balance: "11.00",
      },
    ],
    is_available: true,
  });
  assert.equal(result.currency, "USD");
  assert.equal(result.grantedBalance, 1);
  assert.equal(result.toppedUpBalance, 10);
  assert.equal(result.totalBalance, 11);
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
  assert.equal(result.grantedBalance, -5);
  assert.equal(result.toppedUpBalance, -0.5);
  assert.equal(result.totalBalance, -5.5);
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
    const result = parseBalance(payload);
    for (const field of [
      "grantedBalance",
      "toppedUpBalance",
      "totalBalance",
    ] as const) {
      assert.ok(
        Number.isFinite(result[field]),
        `${field} must be finite for ${JSON.stringify(payload)}`
      );
    }
  }
});
