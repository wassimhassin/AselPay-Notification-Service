// Thin client for the Expo Push HTTP API, using Node's built-in fetch.
// Docs: https://docs.expo.dev/push-notifications/sending-notifications/
//
// Every failure is an ExpoRequestError with `retryable`: network errors,
// timeouts, 429 and 5xx are worth retrying; anything else is not.

const EXPO_TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[^\]\s]+\]$/;

const isExpoPushToken = (token) =>
  typeof token === "string" && EXPO_TOKEN_PATTERN.test(token);

class ExpoRequestError extends Error {
  constructor(message, { retryable, status = null, details = null }) {
    super(message);
    this.name = "ExpoRequestError";
    this.retryable = retryable;
    this.status = status;
    this.details = details;
  }
}

const createExpoClient = ({ sendUrl, receiptsUrl, accessToken, timeoutMs }) => {
  const postJson = async (url, body) => {
    const headers = {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error.name === "TimeoutError" ? "timed out" : error.message;
      throw new ExpoRequestError(`Expo request failed: ${reason}`, { retryable: true });
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      payload = null;
    }

    if (response.status === 429 || response.status >= 500) {
      throw new ExpoRequestError(`Expo responded ${response.status}`, {
        retryable: true,
        status: response.status,
        details: payload?.errors ?? text.slice(0, 500),
      });
    }
    if (!response.ok || !payload || payload.errors) {
      throw new ExpoRequestError(`Expo rejected the request (${response.status})`, {
        retryable: false,
        status: response.status,
        details: payload?.errors ?? text.slice(0, 500),
      });
    }
    return payload.data;
  };

  return {
    // messages: Expo message objects (max 100). Returns one ticket per
    // message, in the same order.
    async sendMessages(messages) {
      const tickets = await postJson(sendUrl, messages);
      if (!Array.isArray(tickets) || tickets.length !== messages.length) {
        throw new ExpoRequestError("Unexpected ticket list from Expo", {
          retryable: false,
          details: tickets,
        });
      }
      return tickets;
    },

    // ids: ticket ids (max 1000). Returns { [id]: receipt }; ids whose
    // receipt isn't ready yet are missing from the result.
    async getReceipts(ids) {
      return (await postJson(receiptsUrl, { ids })) || {};
    },
  };
};

module.exports = { createExpoClient, isExpoPushToken, ExpoRequestError };
