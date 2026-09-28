const express = require("express");
const { validateNotifications } = require("../validation/notification");
const { QueueFullError } = require("../queue/pushQueue");

// POST /v1/notifications
// Validates, queues, and answers at once (202): sending happens in the
// background, so the caller never waits on Expo.
const notificationsRouter = ({ queue, maxTokens }) => {
  const router = express.Router();

  router.post("/", (req, res) => {
    const { errors, messages, rejected } = validateNotifications(req.body, { maxTokens });
    if (errors.length > 0) {
      return res.status(400).json({ error: "VALIDATION_ERROR", details: errors });
    }

    try {
      queue.enqueue(messages);
    } catch (error) {
      if (error instanceof QueueFullError) {
        res.set("Retry-After", "30");
        return res.status(503).json({ error: "QUEUE_FULL" });
      }
      throw error;
    }

    res.status(202).json({ accepted: messages.length, rejected });
  });

  return router;
};

module.exports = notificationsRouter;
