// Request logging, 404 and error handling.

const requestLogger = (logger) => (req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    const context = {
      status: res.statusCode,
      ms: Date.now() - started,
      ip: req.socket.remoteAddress,
    };
    const line = `${req.method} ${req.originalUrl}`;
    if (res.statusCode >= 500) logger.error(line, context);
    else if (res.statusCode >= 400) logger.warn(line, context);
    else if (req.path === "/health") logger.debug(line, context);
    else logger.info(line, context);
  });
  next();
};

const notFound = (req, res) => {
  res.status(404).json({ error: "NOT_FOUND" });
};

// Express 5 forwards rejected promises from async handlers here too.
const errorHandler = (logger) => (error, req, res, next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "INVALID_JSON" });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "PAYLOAD_TOO_LARGE" });
  }
  logger.error("Unhandled error", { error: error.stack || error.message });
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "INTERNAL_ERROR" });
};

module.exports = { requestLogger, notFound, errorHandler };
