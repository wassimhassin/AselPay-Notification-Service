# AselPay Notification Service

Relays push notifications from the AselPay backend to the **Expo Push Service**.

The AselPay backend server has no internet access, so it can't reach Expo
directly. This service runs on a server that does, and the backend calls it
over the local network:

```
App ──► AselPay backend ──(LAN, axios)──► Notification service ──(internet)──► Expo ──► Phones
```

- **Non-blocking:** the API validates, queues and answers `202` at once. The
  backend never waits on Expo, so a notification problem can't slow down a
  recharge or a transfer.
- **Reliable:** network errors, timeouts, `429` and `5xx` are retried with
  exponential backoff (2 s, 4 s, 8 s… up to 5 min, 8 attempts by default).
  Pending notifications are saved on a clean stop and restored at start.
- **Dead-token cleanup:** tokens Expo reports as `DeviceNotRegistered` (app
  uninstalled, notifications disabled) are collected, from the immediate
  answer and from delivery receipts, for the backend to delete.
- **Secured:** shared API key (constant-time check) and optional IP allow-list.
- **Small:** Express + dotenv only. Expo's HTTP API is called with Node's
  built-in `fetch`.

## Requirements

- Node.js **18.17+**
- Outbound HTTPS to `exp.host` (port 443)
- Inbound access on `PORT` from the AselPay backend server

## Setup

```bash
npm install          # on a machine with internet (see Deployment)
cp .env.example .env # then edit .env
npm test             # 26 tests, no network needed
npm start
```

Generate the API key (put the same value in the AselPay backend's `.env`):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `API_KEY` | — (required, ≥ 32 chars) | Secret expected in the `x-api-key` header |
| `ALLOWED_IPS` | empty (any) | Comma-separated client IPs allowed on `/v1` (set it to the backend server's IP) |
| `EXPO_ACCESS_TOKEN` | empty | Only if *Enhanced push security* is enabled on the Expo project |
| `EXPO_TIMEOUT_MS` | `15000` | Timeout per Expo request |
| `QUEUE_MAX_SIZE` | `50000` | Max queued messages; beyond it the API answers `503` |
| `MAX_ATTEMPTS` | `8` | Send attempts before a message is dropped |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | `2000` / `300000` | Backoff bounds |
| `MAX_TOKENS_PER_REQUEST` | `1000` | Device tokens accepted per API call |
| `RECEIPT_DELAY_MINUTES` | `15` | Wait before reading delivery receipts |
| `RECEIPT_INTERVAL_MINUTES` | `5` | How often receipts are checked |
| `DATA_DIR` | `data` | Where `invalid-tokens.json` and `pending-queue.json` are kept |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

The service refuses to start with an invalid configuration and prints what
is wrong.

## API

All `/v1` routes require the `x-api-key` header.

### `POST /v1/notifications`

```json
{
  "notifications": [
    {
      "to": ["ExponentPushToken[xxxx]", "ExponentPushToken[yyyy]"],
      "title": "Transfert reçu",
      "body": "Vous avez reçu 50 DT de Ali Ben Salah",
      "data": { "screen": "Notifications", "transactionId": "65f..." },
      "priority": "high",
      "sound": "default",
      "badge": 1,
      "channelId": "default",
      "ttl": 86400
    }
  ]
}
```

- `to`: one token or an array; `title` and/or `body` required; the rest optional.
- Defaults: `sound: "default"`, `priority: "high"`, `channelId: "default"`.
- A message (with its `data`) must stay under 4096 bytes (Expo limit).

| Status | Body | Meaning |
|---|---|---|
| `202` | `{ "accepted": 2, "rejected": [] }` | Queued. `rejected` lists tokens with an invalid format (the others are still sent). |
| `400` | `{ "error": "VALIDATION_ERROR", "details": [...] }` | Bad body; nothing queued |
| `400` | `{ "error": "INVALID_JSON" }` | Body is not JSON |
| `401` / `403` | `UNAUTHORIZED` / `FORBIDDEN` | Wrong key / IP not allowed |
| `503` | `{ "error": "QUEUE_FULL" }` + `Retry-After` | Try again later |

### `GET /v1/tokens/invalid`

```json
{ "tokens": [{ "token": "ExponentPushToken[...]", "reason": "DeviceNotRegistered", "at": "2026-09-28T14:22:56.379Z" }] }
```

### `POST /v1/tokens/invalid/ack`

Body `{ "tokens": ["ExponentPushToken[...]"] }` → `{ "removed": 1 }`.
Call it after deleting the tokens from the AselPay database.

### `GET /health`

Open (no key). Counters only:

```json
{ "status": "ok", "uptimeSeconds": 120, "queue": { "pending": 0, "inFlight": 0, "sent": 42, "failed": 1, "retried": 3 }, "receiptsPending": 12, "invalidTokens": 1 }
```

## Calling it from the AselPay backend

```js
const axios = require("axios");

const notifier = axios.create({
  baseURL: process.env.NOTIFICATION_SERVICE_URL, // e.g. http://192.168.1.20:4000
  headers: { "x-api-key": process.env.NOTIFICATION_SERVICE_KEY },
  timeout: 5000,
});

// Fire-and-forget: never let a notification failure break the business flow.
const notify = (notifications) =>
  notifier.post("/v1/notifications", { notifications }).catch((error) => {
    console.error("notify failed:", error.response?.status, error.message);
  });
```

## Deployment on the second server

The server has internet, so `npm install` works there directly:

```bash
# copy the folder (without node_modules, .env and data/)
cd AselPay-Notification-Service
npm ci --omit=dev
cp .env.example .env   # set API_KEY, ALLOWED_IPS, PORT
npm test
```

Run it with **PM2** so it restarts on crash and at boot:

```bash
npm install -g pm2
pm2 start index.js --name aselpay-notifications --kill-timeout 15000
pm2 save
pm2 startup            # follow the printed command once
pm2 logs aselpay-notifications
```

`--kill-timeout` gives the service time to finish its current batch and save
the queue on `pm2 restart` / `pm2 stop`.

Open `PORT` in the firewall **only for the AselPay backend server's IP**, and
set the same IP in `ALLOWED_IPS`.

Check from the backend server:

```bash
curl http://<notification-server-ip>:4000/health
```

## Project layout

```
index.js                     startup, graceful shutdown
src/config.js                .env loading and validation
src/app.js                   Express app (routes, middleware)
src/routes/                  /v1/notifications, /v1/tokens
src/middleware/              API key, IP allow-list, logging, errors
src/validation/              request validation -> Expo messages
src/expo/expoClient.js       Expo Push HTTP API client
src/queue/pushQueue.js       send queue, batching, retries
src/queue/receiptTracker.js  delivery receipts, dead-token detection
src/store/                   JSON file storage (atomic writes)
test/                        node:test suites
```

## Limits to know

- The queue is in memory: a **crash** (not a clean stop) loses notifications
  still waiting to be sent. Retries and the clean-stop save cover the usual
  cases; a persistent queue (Redis) would be the next step if this matters.
- Run a **single instance**: the data files are not shared between processes.
