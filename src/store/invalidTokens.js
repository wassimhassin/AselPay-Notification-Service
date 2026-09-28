const { readJson, writeJsonAtomic } = require("./jsonFile");

// Device tokens Expo reported as dead (app uninstalled, notifications
// revoked...). The AselPay backend reads this list, deletes the tokens from
// its database, then acknowledges them so they are removed here.
// Persisted to disk so a restart doesn't lose them.
class InvalidTokenStore {
  constructor({ file, logger }) {
    this.file = file;
    this.logger = logger;
    this.tokens = new Map(); // token -> { reason, at }
    this.saving = Promise.resolve();
  }

  async load() {
    const data = await readJson(this.file, {});
    for (const [token, entry] of Object.entries(data)) {
      this.tokens.set(token, entry);
    }
    return this.tokens.size;
  }

  add(token, reason) {
    if (!token || this.tokens.has(token)) return;
    this.tokens.set(token, { reason, at: new Date().toISOString() });
    this.logger.info("Token marked invalid", { token, reason });
    this.save();
  }

  list() {
    return [...this.tokens].map(([token, entry]) => ({ token, ...entry }));
  }

  // Removes acknowledged tokens; returns how many were removed.
  ack(tokens) {
    let removed = 0;
    for (const token of tokens) {
      if (this.tokens.delete(token)) removed += 1;
    }
    if (removed > 0) this.save();
    return removed;
  }

  get size() {
    return this.tokens.size;
  }

  // Writes are chained so they never overlap.
  save() {
    const snapshot = Object.fromEntries(this.tokens);
    this.saving = this.saving
      .then(() => writeJsonAtomic(this.file, snapshot))
      .catch((error) =>
        this.logger.error("Could not save invalid tokens", { error: error.message })
      );
    return this.saving;
  }
}

module.exports = InvalidTokenStore;
