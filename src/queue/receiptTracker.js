// Follows up on accepted messages. Expo's first answer (the ticket) only says
// a message was accepted; the receipt, available later, says whether Apple or
// Google actually took it. A "DeviceNotRegistered" receipt means the token is
// dead and is recorded in the invalid-token store.

const RECEIPT_CHUNK = 1000; // Expo limit per getReceipts request

class ReceiptTracker {
  constructor({ client, invalidTokens, config, logger, now = Date.now }) {
    this.client = client;
    this.invalidTokens = invalidTokens;
    this.delayMs = config.delayMs;
    this.intervalMs = config.intervalMs;
    this.maxAgeMs = config.maxAgeMs;
    this.maxTracked = config.maxTracked;
    this.logger = logger;
    this.now = now;
    this.pending = new Map(); // ticketId -> { token, sentAt }
    this.timer = null;
    this.checking = false;
  }

  track(ticketId, token) {
    if (!ticketId) return;
    if (this.pending.size >= this.maxTracked) {
      // Oldest first: Map keeps insertion order.
      this.pending.delete(this.pending.keys().next().value);
    }
    this.pending.set(ticketId, { token, sentAt: this.now() });
  }

  get size() {
    return this.pending.size;
  }

  start() {
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async check() {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = this.now();
      const ready = [];
      for (const [id, entry] of this.pending) {
        if (now - entry.sentAt > this.maxAgeMs) {
          this.pending.delete(id); // Expo no longer has it
        } else if (now - entry.sentAt >= this.delayMs) {
          ready.push(id);
        }
      }

      for (let i = 0; i < ready.length; i += RECEIPT_CHUNK) {
        const ids = ready.slice(i, i + RECEIPT_CHUNK);
        let receipts;
        try {
          receipts = await this.client.getReceipts(ids);
        } catch (error) {
          // Kept for the next round.
          this.logger.warn("Could not fetch receipts", { error: error.message });
          return;
        }
        for (const id of ids) {
          const receipt = receipts[id];
          if (!receipt) continue; // not ready yet
          const { token } = this.pending.get(id) || {};
          this.pending.delete(id);
          if (receipt.status === "error") this.handleError(token, receipt);
        }
      }
    } finally {
      this.checking = false;
    }
  }

  handleError(token, receipt) {
    const code = receipt.details?.error;
    if (code === "DeviceNotRegistered") {
      this.invalidTokens.add(token, code);
      return;
    }
    this.logger.error("Notification not delivered", {
      token,
      error: code || "unknown",
      message: receipt.message,
    });
  }
}

module.exports = ReceiptTracker;
