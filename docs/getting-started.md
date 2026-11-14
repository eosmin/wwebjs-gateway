# Getting started

From a clone of the repository to a first message, on a development machine. It takes about ten
minutes plus the time to scan a QR code. This guide runs the gateway from source on a development
machine; the `docker compose up` stack of the repository is also for development only.

**Use a spare phone number.** The gateway automates WhatsApp Web with a library that is not an official
product: an account that is automated can be restricted ([limits](limits.md)). Never try it with
the number your business depends on.

## 1. Requirements

- Node.js 24 and Docker (Postgres and Redis run in containers).
- [gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`), which the pre-commit hook
  of the repository needs, and `openssl`, which the setup script uses to generate secrets.
- A Chromium or Chrome binary. `pnpm install` downloads none, so the gateway needs to be told where one
  is (step 3).

## 2. Install and start the infrastructure

```bash
corepack enable
pnpm bootstrap
```

`pnpm bootstrap` (`scripts/bootstrap.sh`) checks the prerequisites, installs the dependencies and the
Git hooks, creates `.env.local` from `.env.example` with a **random** `ADMIN_API_KEY` and
`METRICS_TOKEN`, starts Postgres and Redis (`docker compose up -d --wait postgres redis`), generates
the Prisma client and applies the migrations.

## 3. Point the gateway at a browser

Open `.env.local` and set the path of your Chromium, for example:

```bash
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Without it a session cannot start. Every variable is described in [config-reference](config-reference.md).

## 4. Run it

```bash
pnpm dev
```

The gateway listens on `http://localhost:3000`. Check it, and keep the admin key at hand (it is the
`ADMIN_API_KEY` of `.env.local`):

```bash
export ADMIN_API_KEY='the value of ADMIN_API_KEY in .env.local'
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

`/health` answers `200` while the process runs; `/ready` answers `200` once Postgres and Redis answer
and the folder of the saved logins is writable ([system](system.md)). With `ENABLE_DOCS` on (the
default outside production) the Swagger UI is at `http://localhost:3000/docs`.

## 5. Create a session and link the phone

A session is one WhatsApp account. Create it, start it and read its QR code:

```bash
curl -X POST http://localhost:3000/v1/sessions \
  -H "X-API-Key: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"main","name":"First session"}'

curl -X POST http://localhost:3000/v1/sessions/main/start \
  -H "X-API-Key: $ADMIN_API_KEY"

curl http://localhost:3000/v1/sessions/main/qr.png \
  -H "X-API-Key: $ADMIN_API_KEY" -o qr.png
```

Open `qr.png` and scan it from the phone: **Settings → Linked devices → Link a device**. WhatsApp
renews the code every few seconds, so fetch it again if it expired. A QR code is a credential until it
is scanned, which is why the routes need the `manage` scope and the code never reaches the logs.

If you prefer to link with a code instead of a QR, `POST /v1/sessions/main/pairing-code` with
`{"phoneNumber":"<digits with country code>"}` answers the code to type on the phone
([sessions](sessions.md)).

Poll the session until its `status` is `ready`:

```bash
curl http://localhost:3000/v1/sessions/main -H "X-API-Key: $ADMIN_API_KEY"
```

The statuses and what each one means are in [sessions](sessions.md). The login is saved under
`WWEBJS_DATA_PATH` (`./.wwebjs_auth` by default), so the next start does not ask for a QR code.
**That folder is an account credential**: never commit it or share it.

## 6. Create an API key for your application

The admin key can do everything and should stay with you. Give an application a key limited to one
session and to the scopes it needs ([authentication](authentication.md)):

```bash
curl -X POST http://localhost:3000/v1/api-keys \
  -H "X-API-Key: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"my-bot","sessionId":"main","scopes":["read","send","events"]}'
```

The raw key is in the `201` answer **and nowhere else**: only its hash is stored. Keep it as
`API_KEY` for the next steps.

## 7. Send a first message

```bash
export API_KEY='the key of the previous step'
curl -X POST http://localhost:3000/v1/sessions/main/messages \
  -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: first-message-1' \
  -d '{"to":"5215500000001","type":"text","body":"Hello from the gateway"}'
```

Replace the number with yours. The answer is `201 { jobId, status: "sent", message }` when the send
finished within `SEND_SYNC_TIMEOUT_MS`, or `202 { jobId, status: "queued" }` when it is still waiting
([send-queue](send-queue.md)). Repeating the request with the same `Idempotency-Key` never sends a
second message.

**A first message to a number that has never written to the account is refused by default**, with
`422 POLICY_BLOCKED` and `details.rule: "cold_sends_disabled"`: the send policy only allows replies in an
open conversation, one where the contact wrote within the last 24 hours (`CONVERSATION_WINDOW_HOURS`).
For a first test, write to the linked account from another phone, then send. `ALLOW_COLD_SENDS=true`
lifts the rule, within the budgets described in [safety](safety.md); think before you turn it on.

The same send from Node:

```js
const response = await fetch('http://localhost:3000/v1/sessions/main/messages', {
  method: 'POST',
  headers: {
    'X-API-Key': process.env.API_KEY,
    'Content-Type': 'application/json',
    'Idempotency-Key': 'first-message-2'
  },
  body: JSON.stringify({ to: '5215500000001', type: 'text', body: 'Hello from Node' })
})
console.log(response.status, await response.json())
```

## 8. Receive messages

There are two ways ([events](events.md) lists every event):

- **Webhook.** The gateway POSTs each event to a URL of yours, signed with a secret:

  ```bash
  curl -X POST http://localhost:3000/v1/webhooks \
    -H "X-API-Key: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
    -d '{"url":"https://example.com/hook","sessionId":"main","events":["message"]}'
  ```

  The `201` answer carries the `secret` once. Verify the signature of every delivery before trusting it
  ([webhooks](webhooks.md)). A target on a private network, such as `http://localhost:4000`, is refused
  unless `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` (development only) or the host is in
  `WEBHOOK_PRIVATE_HOST_ALLOWLIST`.

- **Socket.IO.** Connect with the key and subscribe to the session:

  ```js
  import { io } from 'socket.io-client'

  const socket = io('http://localhost:3000', {
    auth: { apiKey: process.env.API_KEY },
    transports: ['websocket']
  })
  socket.on('wa:event', envelope => console.log(envelope.event, envelope.seq))
  socket.emit('subscribe', { sessionId: 'main', events: ['message'] }, ack => console.log(ack))
  ```

  See [websocket](websocket.md) for the commands, the replay after a reconnect and the backpressure
  rules.

Messages of one contact that arrive together are put in the order the sender wrote them, and a burst
also produces a `message_batch` event ([ordering](ordering.md)).

## Where to go next

- [architecture](architecture.md): how the pieces fit.
- [messages](messages.md), [chats](chats.md), [groups](groups.md): the API by area; the whole list is in
  [operations-list](operations-list.md).
- [errors](errors.md) and [troubleshooting](troubleshooting.md) when something answers an error.
