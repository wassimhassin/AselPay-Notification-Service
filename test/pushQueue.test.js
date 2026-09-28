const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const { PushQueue, QueueFullError } = require("../src/queue/pushQueue");
const { ExpoRequestError } = require("../src/expo/expoClient");
const { nullLogger } = require("../src/logger");

const config = {
  batchSize: 2,
  maxSize: 5,
  maxAttempts: 3,
  baseRetryMs: 1000,
  maxRetryMs: 60000,
  tickMs: 1000,
};

const message = (n) => ({ to: `ExponentPushToken[t${n}]`, body: "x" });

// Builds a queue with a controllable clock and recording fakes.
const setup = ({ send, persistFile = null }) => {
  const clock = { now: 1000 };
  const invalid = [];
  const tracked = [];
  const queue = new PushQueue({
    client: { sendMessages: send },
    invalidTokens: { add: (token, reason) => invalid.push({ token, reason }) },
    receipts: { track: (id, token) => tracked.push({ id, token }) },
    config,
    logger: nullLogger,
    persistFile,
    now: () => clock.now,
    random: () => 0.5, // no jitter
  });
  return { queue, clock, invalid, tracked };
};

test("sends in batches and tracks accepted tickets", async () => {
  const batches = [];
  const { queue, tracked } = setup({
    send: async (msgs) => {
      batches.push(msgs.length);
      return msgs.map((m, i) => ({ status: "ok", id: `id-${m.to}-${i}` }));
    },
  });
  queue.items = [1, 2, 3].map((n) => ({ message: message(n), attempts: 0, notBefore: 0 }));
  await queue.tick();
  await queue.tick();
  assert.deepEqual(batches, [2, 1]);
  assert.equal(tracked.length, 3);
  assert.equal(queue.status().sent, 3);
});

test("retries network errors with exponential backoff, then drops", async () => {
  const { queue, clock } = setup({
    send: async () => {
      throw new ExpoRequestError("down", { retryable: true });
    },
  });
  queue.items = [{ message: message(1), attempts: 0, notBefore: 0 }];

  await queue.tick();
  assert.equal(queue.items[0].attempts, 1);
  assert.equal(queue.items[0].notBefore, clock.now + 1000);

  await queue.tick(); // not due yet
  assert.equal(queue.items[0].attempts, 1);

  clock.now += 1000;
  await queue.tick();
  assert.equal(queue.items[0].notBefore, clock.now + 2000);

  clock.now += 2000;
  await queue.tick(); // 3rd attempt = maxAttempts -> dropped
  assert.equal(queue.pending, 0);
  assert.equal(queue.status().failed, 1);
});

test("drops a batch Expo rejects as invalid (no retry)", async () => {
  const { queue } = setup({
    send: async () => {
      throw new ExpoRequestError("bad request", { retryable: false, status: 400 });
    },
  });
  queue.items = [{ message: message(1), attempts: 0, notBefore: 0 }];
  await queue.tick();
  assert.equal(queue.pending, 0);
  assert.equal(queue.status().failed, 1);
});

test("handles per-message ticket errors", async () => {
  const { queue, invalid } = setup({
    send: async () => [
      { status: "error", details: { error: "DeviceNotRegistered" } },
      { status: "error", details: { error: "MessageRateExceeded" } },
    ],
  });
  queue.items = [1, 2].map((n) => ({ message: message(n), attempts: 0, notBefore: 0 }));
  await queue.tick();
  assert.deepEqual(invalid, [{ token: message(1).to, reason: "DeviceNotRegistered" }]);
  assert.equal(queue.pending, 1); // rate-limited one is retried
  assert.equal(queue.items[0].message.to, message(2).to);
});

test("refuses new messages when full", () => {
  const { queue } = setup({ send: async () => [] });
  queue.items = [1, 2, 3, 4].map((n) => ({ message: message(n), attempts: 0, notBefore: 0 }));
  assert.throws(() => queue.enqueue([message(5), message(6)]), QueueFullError);
});

test("saves pending messages on stop and restores them", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "notif-")), "pending.json");
  const first = setup({ send: async () => [], persistFile: file });
  first.queue.items = [{ message: message(1), attempts: 2, notBefore: 99999 }];
  await first.queue.stop({ drainMs: 0 });

  const second = setup({ send: async () => [], persistFile: file });
  assert.equal(await second.queue.restore(), 1);
  assert.deepEqual(second.queue.items, [{ message: message(1), attempts: 2, notBefore: 0 }]);
  assert.equal(fs.existsSync(file), false);
});
