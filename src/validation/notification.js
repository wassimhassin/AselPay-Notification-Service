const { isExpoPushToken } = require("../expo/expoClient");

// Validates a POST /v1/notifications body and turns it into Expo messages,
// one per device token.
//
// Body:
// {
//   "notifications": [
//     {
//       "to": "ExponentPushToken[...]" | ["ExponentPushToken[...]", ...],
//       "title": "Transfert reçu",           // title and/or body required
//       "body": "Vous avez reçu 50 DT",
//       "data": { "screen": "Notifications" }, // optional, object
//       "sound": "default" | null,             // optional, default "default"
//       "badge": 1,                            // optional, integer >= 0
//       "priority": "default" | "normal" | "high", // optional, default "high"
//       "channelId": "default",                // optional (Android)
//       "ttl": 3600                            // optional, seconds
//     }
//   ]
// }
//
// Structural errors reject the whole request (400). A token with a bad
// format only rejects that token: the others are still sent.

// Expo refuses messages over 4096 bytes.
const MAX_MESSAGE_BYTES = 4096;
const PRIORITIES = ["default", "normal", "high"];

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const validateNotifications = (body, { maxTokens }) => {
  const errors = [];
  const messages = [];
  const rejected = [];

  if (!isPlainObject(body) || !Array.isArray(body.notifications)) {
    return {
      errors: [{ field: "notifications", message: "must be an array" }],
      messages,
      rejected,
    };
  }
  if (body.notifications.length === 0) {
    return {
      errors: [{ field: "notifications", message: "must not be empty" }],
      messages,
      rejected,
    };
  }

  const fail = (index, field, message) => errors.push({ index, field, message });

  body.notifications.forEach((n, index) => {
    if (!isPlainObject(n)) {
      fail(index, "notification", "must be an object");
      return;
    }

    const tokens = Array.isArray(n.to) ? n.to : [n.to];
    if (tokens.length === 0 || tokens.some((t) => typeof t !== "string" || !t.trim())) {
      fail(index, "to", "must be a token or a non-empty array of tokens");
      return;
    }

    const hasTitle = typeof n.title === "string" && n.title.trim() !== "";
    const hasBody = typeof n.body === "string" && n.body.trim() !== "";
    if (!hasTitle && !hasBody) fail(index, "title/body", "title or body is required");
    if (n.title !== undefined && typeof n.title !== "string") fail(index, "title", "must be a string");
    if (n.body !== undefined && typeof n.body !== "string") fail(index, "body", "must be a string");
    if (n.data !== undefined && !isPlainObject(n.data)) fail(index, "data", "must be an object");
    if (n.sound !== undefined && n.sound !== null && n.sound !== "default") {
      fail(index, "sound", 'must be "default" or null');
    }
    if (n.badge !== undefined && !(Number.isInteger(n.badge) && n.badge >= 0)) {
      fail(index, "badge", "must be an integer >= 0");
    }
    if (n.priority !== undefined && !PRIORITIES.includes(n.priority)) {
      fail(index, "priority", `must be one of ${PRIORITIES.join(", ")}`);
    }
    if (n.channelId !== undefined && typeof n.channelId !== "string") {
      fail(index, "channelId", "must be a string");
    }
    if (n.ttl !== undefined && !(Number.isInteger(n.ttl) && n.ttl >= 0)) {
      fail(index, "ttl", "must be an integer >= 0 (seconds)");
    }
    if (errors.some((e) => e.index === index)) return;

    const base = {
      title: hasTitle ? n.title : undefined,
      body: hasBody ? n.body : undefined,
      data: n.data,
      sound: n.sound === undefined ? "default" : n.sound,
      badge: n.badge,
      priority: n.priority || "high",
      channelId: n.channelId || "default",
      ttl: n.ttl,
    };
    // Drop undefined fields so the payload stays minimal.
    Object.keys(base).forEach((key) => base[key] === undefined && delete base[key]);

    const size = Buffer.byteLength(JSON.stringify({ to: "ExponentPushToken[x]", ...base }));
    if (size > MAX_MESSAGE_BYTES) {
      fail(index, "notification", `too large (${size} bytes, max ${MAX_MESSAGE_BYTES})`);
      return;
    }

    for (const token of new Set(tokens.map((t) => t.trim()))) {
      if (isExpoPushToken(token)) {
        messages.push({ to: token, ...base });
      } else {
        rejected.push({ index, token, reason: "INVALID_TOKEN_FORMAT" });
      }
    }
  });

  if (errors.length === 0 && messages.length + rejected.length > maxTokens) {
    errors.push({
      field: "to",
      message: `too many tokens in one request (max ${maxTokens})`,
    });
  }

  return { errors, messages, rejected };
};

module.exports = { validateNotifications, MAX_MESSAGE_BYTES };
