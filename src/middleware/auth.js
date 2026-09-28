const crypto = require("crypto");

// Only the AselPay backend may use the /v1 API.

const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();

// Constant-time comparison of the x-api-key header with API_KEY.
const requireApiKey = (apiKey) => {
  const expected = digest(apiKey);
  return (req, res, next) => {
    const provided = req.get("x-api-key");
    if (!provided || !crypto.timingSafeEqual(digest(provided), expected)) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    next();
  };
};

// "::ffff:10.0.0.5" (IPv4 seen through an IPv6 socket) -> "10.0.0.5"
const normalizeIp = (ip) => String(ip || "").replace(/^::ffff:/, "");

// Optional allow-list of client IPs; empty list = no restriction.
const allowIps = (allowedIps) => {
  const allowed = new Set(allowedIps.map(normalizeIp));
  return (req, res, next) => {
    if (allowed.size === 0) return next();
    const ip = normalizeIp(req.socket.remoteAddress);
    if (!allowed.has(ip)) {
      return res.status(403).json({ error: "FORBIDDEN" });
    }
    next();
  };
};

module.exports = { requireApiKey, allowIps, normalizeIp };
