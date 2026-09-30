const express = require("express");

const { requireApiKey, allowIps } = require("./middleware/auth");
const { requestLogger, notFound, errorHandler } = require("./middleware/http");
const notificationsRouter = require("./routes/notifications");
const tokensRouter = require("./routes/tokens");

// Builds the Express app. Dependencies are passed in so tests can use fakes.
const createApp = ({ config, queue, receipts, invalidTokens, logger }) => {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  app.use(requestLogger(logger));
  app.use(express.json({ limit: "1mb" }));

  // Service info, so opening the base URL doesn't look like an error.
  app.get("/", (req, res) => {
    res.json({ service: "aselpay-notification-service", status: "ok", health: "/health" });
  });

  // Open for monitoring; exposes counters only.
  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      queue: queue.status(),
      receiptsPending: receipts.size,
      invalidTokens: invalidTokens.size,
    });
  });

  const v1 = express.Router();
  v1.use(allowIps(config.allowedIps), requireApiKey(config.apiKey));
  v1.use("/notifications", notificationsRouter({ queue, maxTokens: config.maxTokensPerRequest }));
  v1.use("/tokens", tokensRouter({ invalidTokens }));
  app.use("/v1", v1);

  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
};

module.exports = createApp;
