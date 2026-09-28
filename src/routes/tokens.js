const express = require("express");

// Dead device tokens, for the AselPay backend to clean up:
//   GET  /v1/tokens/invalid      -> { tokens: [{ token, reason, at }] }
//   POST /v1/tokens/invalid/ack  { tokens: [...] } -> { removed }
// The backend deletes the tokens from its database, then acknowledges them.
const tokensRouter = ({ invalidTokens }) => {
  const router = express.Router();

  router.get("/invalid", (req, res) => {
    res.json({ tokens: invalidTokens.list() });
  });

  router.post("/invalid/ack", (req, res) => {
    const tokens = req.body?.tokens;
    if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== "string")) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        details: [{ field: "tokens", message: "must be an array of strings" }],
      });
    }
    res.json({ removed: invalidTokens.ack(tokens) });
  });

  return router;
};

module.exports = tokensRouter;
