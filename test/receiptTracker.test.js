const test = require("node:test");
const assert = require("node:assert/strict");

const ReceiptTracker = require("../src/queue/receiptTracker");
const { nullLogger } = require("../src/logger");

const MINUTE = 60 * 1000;

const setup = (getReceipts) => {
  const clock = { now: 0 };
  const invalid = [];
  const tracker = new ReceiptTracker({
    client: { getReceipts },
    invalidTokens: { add: (token, reason) => invalid.push({ token, reason }) },
    config: { delayMs: 15 * MINUTE, intervalMs: MINUTE, maxAgeMs: 60 * MINUTE, maxTracked: 3 },
    logger: nullLogger,
    now: () => clock.now,
  });
  return { tracker, clock, invalid };
};

test("waits for the delay, then records dead tokens", async () => {
  const asked = [];
  const { tracker, clock, invalid } = setup(async (ids) => {
    asked.push(...ids);
    return {
      a: { status: "ok" },
      b: { status: "error", details: { error: "DeviceNotRegistered" } },
    };
  });
  tracker.track("a", "tokA");
  tracker.track("b", "tokB");
  tracker.track("c", "tokC");

  await tracker.check();
  assert.deepEqual(asked, []); // too early

  clock.now += 15 * MINUTE;
  await tracker.check();
  assert.deepEqual(invalid, [{ token: "tokB", reason: "DeviceNotRegistered" }]);
  assert.equal(tracker.size, 1); // "c" has no receipt yet: kept
});

test("keeps tickets when Expo can't be reached", async () => {
  const { tracker, clock } = setup(async () => {
    throw new Error("network");
  });
  tracker.track("a", "tokA");
  clock.now += 15 * MINUTE;
  await tracker.check();
  assert.equal(tracker.size, 1);
});

test("forgets tickets older than Expo keeps receipts", async () => {
  const { tracker, clock } = setup(async () => ({}));
  tracker.track("a", "tokA");
  clock.now += 61 * MINUTE;
  await tracker.check();
  assert.equal(tracker.size, 0);
});

test("caps the number of tracked tickets", () => {
  const { tracker } = setup(async () => ({}));
  ["a", "b", "c", "d"].forEach((id) => tracker.track(id, `tok-${id}`));
  assert.equal(tracker.size, 3);
  assert.equal(tracker.pending.has("a"), false);
});
