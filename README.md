# LINE Rental Management Bot

A LINE-native bot that lives in each condo's group chat, verifies tenant payment
slips against the bank, reconciles them against expected rent, and gives the
landlord a per-unit ledger and portfolio view.

**Current phase: 0 — Foundations.** The webhook receives LINE events, verifies
their signature, and echoes them; the Supabase schema is defined and migratable.

## Stack

- **Messaging:** LINE Messaging API + LIFF
- **Backend:** Node / TypeScript + Fastify (`/webhook` + health)
- **DB:** Supabase (Postgres)

## Prerequisites

- Node ≥ 18.18
- A LINE Messaging API channel (channel secret + long-lived access token)
- A Supabase project (use a **separate** project for dev vs prod)

## Setup

```bash
npm install
cp .env.example .env      # fill in LINE + Supabase values
```

### Database

Migrations live in `supabase/migrations`. With the Supabase CLI linked to your
project:

```bash
supabase db push          # applies 0001_init.sql
```

Or paste `supabase/migrations/0001_init.sql` into the Supabase SQL editor.

### Run

```bash
npm run dev               # tsx watch, hot reload
# or
npm run build && npm start
```

Expose the local port to LINE with a tunnel (e.g. `ngrok http 3000`) and set the
webhook URL to `https://<tunnel>/webhook` in the LINE Developers Console.

**In the LINE OA settings:** enable *"Allow bot to join group chats"* and turn
**off** auto-reply / greeting messages so the webhook owns all events.

### Verify Phase 0

- `GET /health` → `{ "status": "ok" }`
- Send a text to the bot → it replies `echo: <text>`
- Send an image → it acknowledges (real slip pipeline arrives in Phase 2)

## Environment variables

| Var | Purpose |
|---|---|
| `NODE_ENV` | `development` \| `production` \| `test` |
| `PORT` | HTTP port (default 3000) |
| `LINE_CHANNEL_SECRET` | Verifies the `x-line-signature` header |
| `LINE_CHANNEL_ACCESS_TOKEN` | Auth for reply/push/content APIs |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side key (bypasses RLS — keep secret) |

Config is loaded from `.env.${NODE_ENV}` first, then `.env` as a fallback, and
validated on boot (`src/config.ts`) — the server refuses to start if a required
value is missing.

## Layout

```
src/
  config.ts            env loading + validation (fail-fast)
  server.ts            Fastify bootstrap, raw-body parser, health route
  routes/webhook.ts    POST /webhook — signature check + event dispatch
  line/client.ts       LINE Messaging API client (reply, content, member name)
  line/handleEvent.ts  per-event handling (Phase 0: echo)
  db/client.ts         Supabase server client
supabase/migrations/
  0001_init.sql        core schema (spec §3)
```

## Roadmap

| Phase | Deliverable |
|---|---|
| **0** | Foundations — webhook + schema *(you are here)* |
| 1 | Setup flows — LIFF Add-Lease form, `/setup` group binding, CRUD |
| 2 | Income + reconciliation — slip → verify → match → ledger → reply |
| 3 | Landlord views — `/status`, LIFF dashboard, monthly summary |
| 4 | Expenses — 1:1 forward-slip → category → `out` txn |
| 5 | Reminders — cron invoice generation + overdue nudges |
