const test = require("node:test");
const assert = require("node:assert/strict");
const { validateNotifications } = require("../src/validation/notification");

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const validate = (body, maxTokens = 1000) => validateNotifications(body, { maxTokens });

test("builds one Expo message per token with defaults", () => {
  const { errors, messages, rejected } = validate({
    notifications: [{ to: [TOKEN_A, TOKEN_B], title: "Transfert reçu", body: "50 DT" }],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(rejected, []);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], {
    to: TOKEN_A,
    title: "Transfert reçu",
    body: "50 DT",
    sound: "default",
    priority: "high",
    channelId: "default",
  });
});

test("rejects bad tokens individually and keeps the good ones", () => {
  const { errors, messages, rejected } = validate({
    notifications: [{ to: [TOKEN_A, "not-a-token"], body: "x" }],
  });
  assert.deepEqual(errors, []);
  assert.equal(messages.length, 1);
  assert.deepEqual(rejected, [{ index: 0, token: "not-a-token", reason: "INVALID_TOKEN_FORMAT" }]);
});

test("removes duplicate tokens", () => {
  const { messages } = validate({ notifications: [{ to: [TOKEN_A, TOKEN_A], body: "x" }] });
  assert.equal(messages.length, 1);
});

test("requires a notifications array", () => {
  assert.equal(validate({}).errors[0].field, "notifications");
  assert.equal(validate({ notifications: [] }).errors[0].message, "must not be empty");
  assert.equal(validate(null).errors.length, 1);
});

test("requires a title or a body", () => {
  const { errors } = validate({ notifications: [{ to: TOKEN_A }] });
  assert.equal(errors[0].field, "title/body");
});

test("checks optional field types", () => {
  const { errors } = validate({
    notifications: [
      { to: TOKEN_A, body: "x", data: "nope", badge: -1, priority: "urgent", sound: "bell", ttl: 1.5 },
    ],
  });
  const fields = errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ["badge", "data", "priority", "sound", "ttl"]);
});

test("refuses messages over Expo's 4096-byte limit", () => {
  const { errors } = validate({
    notifications: [{ to: TOKEN_A, body: "x", data: { blob: "a".repeat(5000) } }],
  });
  assert.match(errors[0].message, /too large/);
});

test("limits the number of tokens per request", () => {
  const { errors } = validate({ notifications: [{ to: [TOKEN_A, TOKEN_B], body: "x" }] }, 1);
  assert.match(errors[0].message, /too many tokens/);
});
