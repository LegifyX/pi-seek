import assert from "node:assert/strict";
import { test } from "node:test";
import { __test } from "../src/index.ts";

const originalFetch = globalThis.fetch;
const STATUS_401 = /DeepSeek API 401/;
const STATUS_500 = /DeepSeek API 500/;
const AUTH_ERROR = /Authentication Fails/;

const makeStore = (
  ttlMs?: number
): ReturnType<typeof __test.createBalanceStore> =>
  __test.createBalanceStore(
    __test.createHttpClient({ resolveApiKey: async () => "k" }),
    ttlMs
  );

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });

test("parseBalance: normalizes the live-verified response shape", () => {
  assert.deepEqual(
    __test.parseBalance({
      balance_infos: [
        {
          currency: "USD",
          granted_balance: "0.00",
          topped_up_balance: "24.62",
          total_balance: "24.62",
        },
      ],
      is_available: true,
    }),
    {
      currency: "USD",
      grantedBalance: 0,
      isAvailable: true,
      toppedUpBalance: 24.62,
      totalBalance: 24.62,
    }
  );
});

test("parseBalance: prefers USD when multiple currencies are present", () => {
  assert.deepEqual(
    __test.parseBalance({
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
    }),
    {
      currency: "USD",
      grantedBalance: 1,
      isAvailable: true,
      toppedUpBalance: 10,
      totalBalance: 11,
    }
  );
});

test("parseBalance: falls back to the first entry without USD", () => {
  const result = __test.parseBalance({
    balance_infos: [
      {
        currency: "CNY",
        granted_balance: "5.00",
        topped_up_balance: "95.00",
        total_balance: "100.00",
      },
    ],
    is_available: true,
  });
  assert.equal(result.currency, "CNY");
  assert.equal(result.totalBalance, 100);
});

test("parseBalance: missing fields and non-numeric amounts default to 0", () => {
  // A partially malformed entry with at least one usable amount still parses
  // and stays available; unparseable fields collapse to 0.
  assert.deepEqual(
    __test.parseBalance({
      balance_infos: [
        {
          currency: "USD",
          granted_balance: "abc",
          topped_up_balance: undefined,
          total_balance: "12.5",
        },
      ],
    }),
    {
      currency: "USD",
      grantedBalance: 0,
      isAvailable: true,
      toppedUpBalance: 0,
      totalBalance: 12.5,
    }
  );
  // A body with no usable balance info at all is unavailable, not a valid
  // zero balance.
  assert.deepEqual(__test.parseBalance(undefined), {
    currency: "USD",
    grantedBalance: 0,
    isAvailable: false,
    toppedUpBalance: 0,
    totalBalance: 0,
  });
  assert.deepEqual(__test.parseBalance({}), {
    currency: "USD",
    grantedBalance: 0,
    isAvailable: false,
    toppedUpBalance: 0,
    totalBalance: 0,
  });
});

test("parseBalance: a valid zero balance stays available and distinct from unavailable", () => {
  assert.deepEqual(
    __test.parseBalance({
      balance_infos: [
        {
          currency: "USD",
          granted_balance: "0.00",
          topped_up_balance: "0.00",
          total_balance: "0.00",
        },
      ],
      is_available: true,
    }),
    {
      currency: "USD",
      grantedBalance: 0,
      isAvailable: true,
      toppedUpBalance: 0,
      totalBalance: 0,
    }
  );
  // Every entry malformed: indistinguishable from a real zero except that
  // the payload reports unavailable.
  assert.deepEqual(
    __test.parseBalance({
      balance_infos: [
        {
          currency: "USD",
          granted_balance: "not-a-number",
          topped_up_balance: "also-bad",
          total_balance: "nope",
        },
      ],
      is_available: true,
    }),
    {
      currency: "USD",
      grantedBalance: 0,
      isAvailable: false,
      toppedUpBalance: 0,
      totalBalance: 0,
    }
  );
});

test("parseBalance: preserves is_available false", () => {
  const result = __test.parseBalance({
    balance_infos: [],
    is_available: false,
  });
  assert.equal(result.isAvailable, false);
});

test("balance store: fetches and normalizes with a fetchedAt stamp", async (t) => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse({
        balance_infos: [
          {
            currency: "USD",
            granted_balance: "0.00",
            topped_up_balance: "24.62",
            total_balance: "24.62",
          },
        ],
        is_available: true,
      })
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const balance = await makeStore().get();
  assert.equal(balance.isAvailable, true);
  assert.equal(balance.currency, "USD");
  assert.equal(balance.totalBalance, 24.62);
  assert.equal(balance.toppedUpBalance, 24.62);
  assert.ok(balance.fetchedAt > 0);
});

test("balance store: refreshes after the TTL expires", async (t) => {
  let balance = "10.00";
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse({
        balance_infos: [
          {
            currency: "USD",
            granted_balance: "0.00",
            topped_up_balance: balance,
            total_balance: balance,
          },
        ],
        is_available: true,
      })
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const store = makeStore(0);
  const first = await store.get();
  balance = "20.00";
  const second = await store.get();
  assert.equal(first.totalBalance, 10);
  assert.equal(second.totalBalance, 20);
});

test("balance store: unavailable payload surfaces as isAvailable false", async (t) => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse({
        balance_infos: [
          {
            currency: "USD",
            granted_balance: "0.00",
            topped_up_balance: "0.00",
            total_balance: "0.00",
          },
        ],
        is_available: false,
      })
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const balance = await makeStore().get();
  assert.equal(balance.isAvailable, false);
  assert.equal(balance.totalBalance, 0);
});

test("balance store: malformed payload yields finite numbers and unavailable state", async (t) => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse({
        balance_infos: [
          {
            currency: "USD",
            granted_balance: "NaN",
            topped_up_balance: "Infinity",
            total_balance: "garbage",
          },
        ],
      })
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const balance = await makeStore().get();
  assert.equal(balance.isAvailable, false);
  assert.ok(Number.isFinite(balance.grantedBalance));
  assert.ok(Number.isFinite(balance.toppedUpBalance));
  assert.ok(Number.isFinite(balance.totalBalance));
  assert.ok(Number.isFinite(balance.fetchedAt));
});

test("balance store: serves the cached value within the TTL", async (t) => {
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    return Promise.resolve(
      jsonResponse({
        balance_infos: [
          {
            currency: "USD",
            granted_balance: "0.00",
            topped_up_balance: "10.00",
            total_balance: "10.00",
          },
        ],
        is_available: true,
      })
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const store = makeStore();
  await store.get();
  await store.get();
  assert.equal(fetchCalls, 1);
});

test("balance store: keeps the stale value and rethrows on refresh failure", async (t) => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse({
        balance_infos: [
          {
            currency: "USD",
            granted_balance: "0.00",
            topped_up_balance: "10.00",
            total_balance: "10.00",
          },
        ],
        is_available: true,
      })
    );
  const store = makeStore(0);
  const first = await store.get();
  globalThis.fetch = () => Promise.resolve(jsonResponse("boom", 500));
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(store.get(), STATUS_500);
  assert.equal(store.peek(), first);
});

test("balance store: maps a 401 with the error body snippet", async (t) => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse(
        { error: { message: "Authentication Fails, Your api key is invalid" } },
        401
      )
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(makeStore().get(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, STATUS_401);
    assert.match(error.message, AUTH_ERROR);
    return true;
  });
});

test("balance store: propagates network failures unwrapped", async (t) => {
  const networkError = new Error("network down");
  globalThis.fetch = () => Promise.reject(networkError);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(makeStore().get(), (error: unknown) => {
    assert.equal(error, networkError);
    return true;
  });
});
