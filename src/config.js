const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

// All settings come from the environment (.env). Invalid settings stop the
// service at startup with a clear list, instead of failing later at runtime.

const problems = [];

const readInt = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return value;
};

const readList = (name) =>
  (process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const apiKey = (process.env.API_KEY || "").trim();
if (apiKey.length < 32) {
  problems.push("API_KEY is required and must be at least 32 characters long");
}

const MINUTE = 60 * 1000;

const config = {
  port: readInt("PORT", 4000, { min: 1, max: 65535 }),
  host: (process.env.HOST || "0.0.0.0").trim(),

  // Shared secret the AselPay backend sends in the x-api-key header.
  apiKey,
  // Optional: only these client IPs may call the /v1 API (empty = any).
  allowedIps: readList("ALLOWED_IPS"),
  // Behind a reverse proxy every request comes from the proxy (127.0.0.1).
  // Set to the proxy's address ("loopback" for a proxy on the same machine)
  // so the client IP is read from X-Forwarded-For. Empty = no proxy.
  trustProxy: (process.env.TRUST_PROXY || "").trim() || null,

  expo: {
    sendUrl: "https://exp.host/--/api/v2/push/send",
    receiptsUrl: "https://exp.host/--/api/v2/push/getReceipts",
    // Optional: required only if "Enhanced push security" is enabled on Expo.
    accessToken: (process.env.EXPO_ACCESS_TOKEN || "").trim() || null,
    timeoutMs: readInt("EXPO_TIMEOUT_MS", 15000, { min: 1000 }),
  },

  queue: {
    // Expo accepts at most 100 messages per request.
    batchSize: 100,
    maxSize: readInt("QUEUE_MAX_SIZE", 50000, { min: 100 }),
    maxAttempts: readInt("MAX_ATTEMPTS", 8, { min: 1, max: 50 }),
    baseRetryMs: readInt("RETRY_BASE_MS", 2000, { min: 100 }),
    maxRetryMs: readInt("RETRY_MAX_MS", 5 * MINUTE, { min: 1000 }),
    tickMs: 500,
  },

  receipts: {
    // Expo recommends waiting ~15 minutes before reading receipts; they are
    // kept for 24 hours.
    delayMs: readInt("RECEIPT_DELAY_MINUTES", 15, { min: 1 }) * MINUTE,
    intervalMs: readInt("RECEIPT_INTERVAL_MINUTES", 5, { min: 1 }) * MINUTE,
    maxAgeMs: 23 * 60 * MINUTE,
    maxTracked: 100000,
  },

  // Per API request: total number of device tokens accepted.
  maxTokensPerRequest: readInt("MAX_TOKENS_PER_REQUEST", 1000, { min: 1 }),

  dataDir: path.resolve(__dirname, "..", process.env.DATA_DIR || "data"),
  logLevel: (process.env.LOG_LEVEL || "info").trim().toLowerCase(),
};

if (!["debug", "info", "warn", "error"].includes(config.logLevel)) {
  problems.push(`LOG_LEVEL must be one of debug, info, warn, error (got "${config.logLevel}")`);
}

config.problems = problems;

module.exports = config;
