// Minimal leveled logger: one line per event, timestamp first, optional
// context as JSON. Enough to follow the service with `pm2 logs` or journalctl
// without adding a dependency.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const createLogger = (level = "info") => {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (name, message, context) => {
    if (LEVELS[name] < threshold) return;
    let line = `${new Date().toISOString()} ${name.toUpperCase().padEnd(5)} ${message}`;
    if (context !== undefined) {
      try {
        line += ` ${JSON.stringify(context)}`;
      } catch (error) {
        line += " [unserializable context]";
      }
    }
    const stream = LEVELS[name] >= LEVELS.warn ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  };

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
};

// Silent logger for tests.
const nullLogger = { debug() {}, info() {}, warn() {}, error() {} };

module.exports = { createLogger, nullLogger };
