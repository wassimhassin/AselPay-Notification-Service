const path = require("path");

const config = require("./src/config");
const { createLogger } = require("./src/logger");
const createApp = require("./src/app");
const { createExpoClient } = require("./src/expo/expoClient");
const InvalidTokenStore = require("./src/store/invalidTokens");
const ReceiptTracker = require("./src/queue/receiptTracker");
const { PushQueue } = require("./src/queue/pushQueue");

const logger = createLogger(config.logLevel);

if (config.problems.length > 0) {
  logger.error("Invalid configuration, see .env.example", { problems: config.problems });
  process.exit(1);
}

const start = async () => {
  const client = createExpoClient(config.expo);

  const invalidTokens = new InvalidTokenStore({
    file: path.join(config.dataDir, "invalid-tokens.json"),
    logger,
  });
  const receipts = new ReceiptTracker({
    client,
    invalidTokens,
    config: config.receipts,
    logger,
  });
  const queue = new PushQueue({
    client,
    invalidTokens,
    receipts,
    config: config.queue,
    logger,
    persistFile: path.join(config.dataDir, "pending-queue.json"),
  });

  const knownInvalid = await invalidTokens.load();
  const restored = await queue.restore();
  queue.start();
  receipts.start();

  const app = createApp({ config, queue, receipts, invalidTokens, logger });
  const server = app.listen(config.port, config.host, () => {
    logger.info("Notification service listening", {
      host: config.host,
      port: config.port,
      restoredNotifications: restored,
      knownInvalidTokens: knownInvalid,
      ipAllowList: config.allowedIps.length > 0 ? config.allowedIps : "off",
    });
  });

  // Clean stop (Ctrl+C, pm2 stop/restart, systemctl stop): stop accepting
  // requests, let the batch in progress finish, save what's still queued.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info("Shutting down", { signal });
    server.close();
    receipts.stop();
    try {
      await queue.stop({ drainMs: 10000 });
      await invalidTokens.saving;
    } catch (error) {
      logger.error("Error during shutdown", { error: error.message });
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason: String(reason?.stack || reason) });
});

start().catch((error) => {
  logger.error("Failed to start", { error: error.stack || error.message });
  process.exit(1);
});
