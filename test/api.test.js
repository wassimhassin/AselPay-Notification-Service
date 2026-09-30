const test = require("node:test");
const assert = require("node:assert/strict");

const createApp = require("../src/app");
const { QueueFullError } = require("../src/queue/pushQueue");
const { nullLogger } = require("../src/logger");

const API_KEY = "k".repeat(40);
const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

// Starts the app on a random port with fake dependencies.
const startApp = async ({ allowedIps = [], queueFull = false, trustProxy = null } = {}) => {
  const enqueued = [];
  const invalid = new Map([["ExponentPushToken[dead]", { reason: "DeviceNotRegistered", at: "t" }]]);
  const queue = {
    enqueue: (messages) => {
      if (queueFull) throw new QueueFullError();
      enqueued.push(...messages);
      return messages.length;
    },
    status: () => ({ pending: enqueued.length }),
  };
  const invalidTokens = {
    list: () => [...invalid].map(([token, e]) => ({ token, ...e })),
    ack: (tokens) => tokens.filter((t) => invalid.delete(t)).length,
    get size() {
      return invalid.size;
    },
  };
  const app = createApp({
    config: { apiKey: API_KEY, allowedIps, trustProxy, maxTokensPerRequest: 1000 },
    queue,
    receipts: { size: 0 },
    invalidTokens,
    logger: nullLogger,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body, key = API_KEY, extraHeaders = {}) =>
    fetch(base + url, {
      method,
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-api-key": key } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  return { call, enqueued, close: () => server.close() };
};

test("health is open and reports counters", async () => {
  const api = await startApp();
  const res = await api.call("GET", "/health", undefined, null);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.invalidTokens, 1);
  api.close();
});

test("rejects a missing or wrong API key", async () => {
  const api = await startApp();
  assert.equal((await api.call("GET", "/v1/tokens/invalid", undefined, null)).status, 401);
  assert.equal((await api.call("GET", "/v1/tokens/invalid", undefined, "wrong")).status, 401);
  api.close();
});

test("enforces the IP allow-list", async () => {
  const api = await startApp({ allowedIps: ["10.0.0.9"] });
  assert.equal((await api.call("GET", "/v1/tokens/invalid")).status, 403);
  api.close();
  const local = await startApp({ allowedIps: ["127.0.0.1"] });
  assert.equal((await local.call("GET", "/v1/tokens/invalid")).status, 200);
  local.close();
});

test("behind a proxy, checks the forwarded client IP", async () => {
  const api = await startApp({ allowedIps: ["172.31.245.86"], trustProxy: "loopback" });
  const via = (ip) =>
    api.call("GET", "/v1/tokens/invalid", undefined, API_KEY, { "x-forwarded-for": ip });
  assert.equal((await via("172.31.245.86")).status, 200);
  assert.equal((await via("8.8.8.8")).status, 403);
  api.close();
});

test("root answers with service info", async () => {
  const api = await startApp();
  const res = await api.call("GET", "/", undefined, null);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).service, "aselpay-notification-service");
  api.close();
});

test("queues valid notifications and answers 202", async () => {
  const api = await startApp();
  const res = await api.call("POST", "/v1/notifications", {
    notifications: [{ to: [TOKEN, "bad"], title: "Transfert reçu", body: "50 DT" }],
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, 1);
  assert.equal(body.rejected[0].token, "bad");
  assert.equal(api.enqueued[0].to, TOKEN);
  api.close();
});

test("returns validation details on a bad body", async () => {
  const api = await startApp();
  const res = await api.call("POST", "/v1/notifications", { notifications: [{ to: TOKEN }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "VALIDATION_ERROR");
  api.close();
});

test("returns 400 on malformed JSON", async () => {
  const api = await startApp();
  const res = await api.call("POST", "/v1/notifications", "{not json");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_JSON");
  api.close();
});

test("returns 503 with Retry-After when the queue is full", async () => {
  const api = await startApp({ queueFull: true });
  const res = await api.call("POST", "/v1/notifications", {
    notifications: [{ to: TOKEN, body: "x" }],
  });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "30");
  api.close();
});

test("lists and acknowledges invalid tokens", async () => {
  const api = await startApp();
  const list = await (await api.call("GET", "/v1/tokens/invalid")).json();
  assert.equal(list.tokens[0].token, "ExponentPushToken[dead]");
  const ack = await api.call("POST", "/v1/tokens/invalid/ack", { tokens: ["ExponentPushToken[dead]"] });
  assert.deepEqual(await ack.json(), { removed: 1 });
  api.close();
});
