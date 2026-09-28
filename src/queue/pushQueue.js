const { readJson, writeJsonAtomic, removeFile } = require("../store/jsonFile");

// In-memory send queue with retries.
//
// - The API only enqueues, so the AselPay backend never waits on Expo.
// - A worker sends up to `batchSize` messages per Expo request.
// - Network errors, timeouts, 429/5xx and per-message rate limiting are
//   retried with exponential backoff (+ jitter), up to `maxAttempts`.
// - On shutdown the remaining messages are written to disk and reloaded at
//   the next start. A crash (not a clean stop) loses what was queued.

class QueueFullError extends Error {
  constructor() {
    super("Notification queue is full");
    this.name = "QueueFullError";
  }
}

// Per-message ticket errors worth retrying; everything else is final.
const RETRYABLE_TICKET_ERRORS = new Set(["MessageRateExceeded"]);

class PushQueue {
  constructor({
    client,
    invalidTokens,
    receipts,
    config,
    logger,
    persistFile = null,
    now = Date.now,
    random = Math.random,
  }) {
    this.client = client;
    this.invalidTokens = invalidTokens;
    this.receipts = receipts;
    this.batchSize = config.batchSize;
    this.maxSize = config.maxSize;
    this.maxAttempts = config.maxAttempts;
    this.baseRetryMs = config.baseRetryMs;
    this.maxRetryMs = config.maxRetryMs;
    this.tickMs = config.tickMs;
    this.logger = logger;
    this.persistFile = persistFile;
    this.now = now;
    this.random = random;

    this.items = []; // { message, attempts, notBefore }
    this.inFlight = 0;
    this.sending = false;
    this.timer = null;
    this.stats = { sent: 0, failed: 0, retried: 0 };
  }

  get pending() {
    return this.items.length;
  }

  status() {
    return { pending: this.items.length, inFlight: this.inFlight, ...this.stats };
  }

  // Adds Expo messages (one token each). Throws QueueFullError when full.
  enqueue(messages) {
    if (this.items.length + messages.length > this.maxSize) {
      throw new QueueFullError();
    }
    for (const message of messages) {
      this.items.push({ message, attempts: 0, notBefore: 0 });
    }
    setImmediate(() => this.tick());
    return messages.length;
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  // Sends one batch of due messages. Runs one batch at a time.
  async tick() {
    if (this.sending) return;
    const now = this.now();
    const batch = [];
    this.items = this.items.filter((item) => {
      if (batch.length < this.batchSize && item.notBefore <= now) {
        batch.push(item);
        return false;
      }
      return true;
    });
    if (batch.length === 0) return;

    this.sending = true;
    this.inFlight = batch.length;
    try {
      await this.sendBatch(batch);
    } finally {
      this.sending = false;
      this.inFlight = 0;
    }
    // More messages already due: keep going without waiting for the timer.
    if (this.items.some((item) => item.notBefore <= this.now())) {
      setImmediate(() => this.tick());
    }
  }

  async sendBatch(batch) {
    let tickets;
    try {
      tickets = await this.client.sendMessages(batch.map((item) => item.message));
    } catch (error) {
      if (error.retryable) {
        this.logger.warn("Expo request failed, will retry", {
          error: error.message,
          count: batch.length,
        });
        batch.forEach((item) => this.retry(item, error.message));
      } else {
        this.stats.failed += batch.length;
        this.logger.error("Expo rejected a batch, dropped", {
          error: error.message,
          status: error.status,
          details: error.details,
          count: batch.length,
        });
      }
      return;
    }

    tickets.forEach((ticket, index) => {
      const item = batch[index];
      const token = item.message.to;
      if (ticket.status === "ok") {
        this.stats.sent += 1;
        this.receipts.track(ticket.id, token);
        return;
      }
      const code = ticket.details?.error;
      if (code === "DeviceNotRegistered") {
        this.stats.failed += 1;
        this.invalidTokens.add(token, code);
      } else if (RETRYABLE_TICKET_ERRORS.has(code)) {
        this.retry(item, code);
      } else {
        this.stats.failed += 1;
        this.logger.error("Notification refused by Expo", {
          token,
          error: code || "unknown",
          message: ticket.message,
        });
      }
    });
  }

  retry(item, reason) {
    item.attempts += 1;
    if (item.attempts >= this.maxAttempts) {
      this.stats.failed += 1;
      this.logger.error("Notification dropped after max attempts", {
        token: item.message.to,
        attempts: item.attempts,
        reason,
      });
      return;
    }
    this.stats.retried += 1;
    item.notBefore = this.now() + this.backoffMs(item.attempts);
    this.items.push(item);
  }

  // 2s, 4s, 8s... capped, with ±20% jitter so retries don't all fire at once.
  backoffMs(attempts) {
    const base = Math.min(this.baseRetryMs * 2 ** (attempts - 1), this.maxRetryMs);
    return Math.round(base * (0.8 + this.random() * 0.4));
  }

  // Restores messages saved by a previous clean shutdown.
  async restore() {
    if (!this.persistFile) return 0;
    const saved = await readJson(this.persistFile, []);
    for (const item of saved) {
      if (item && item.message) {
        this.items.push({ message: item.message, attempts: item.attempts || 0, notBefore: 0 });
      }
    }
    await removeFile(this.persistFile);
    return saved.length;
  }

  // Stops the worker, lets the batch in progress finish (up to drainMs), then
  // saves what's left.
  async stop({ drainMs = 10000 } = {}) {
    clearInterval(this.timer);
    this.timer = null;
    const deadline = this.now() + drainMs;
    while (this.sending && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.persistFile && this.items.length > 0) {
      await writeJsonAtomic(
        this.persistFile,
        this.items.map(({ message, attempts }) => ({ message, attempts }))
      );
      this.logger.info("Saved pending notifications", { count: this.items.length });
    }
  }
}

module.exports = { PushQueue, QueueFullError };
