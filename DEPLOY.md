# Deploying to Railway

The bot is a single Node process (plus the cloud Supabase DB). Railway keeps it
running 24/7 with a **stable public URL**, which replaces the dev box + cloudflared
tunnel. Once deployed you update the LINE webhook / LIFF endpoint **once** and never
touch a tunnel URL again.

Build is defined by [`Dockerfile`](Dockerfile) (multi-stage: compile TS → ship
`dist/` + `public/` + prod deps only). [`railway.json`](railway.json) pins a single
replica, a `/health` healthcheck, and restart-on-failure.

---

## One-time setup

### 1. Push this repo to GitHub
A git repo with an initial commit already exists locally. Create an empty GitHub repo
(no README), then:

```sh
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```

### 2. Create the Railway service
1. Railway → **New Project → Deploy from GitHub repo** → pick this repo.
2. Railway auto-detects the `Dockerfile` and builds. The first deploy will **fail health
   checks until the env vars below are set** — that's expected.

### 3. Set environment variables
Railway → your service → **Variables**. Add every key from
[`.env.example`](.env.example) **except** `PORT` (Railway injects its own). Use your
**production** values:

| Variable | Notes |
| --- | --- |
| `NODE_ENV` | `production` |
| `LINE_CHANNEL_SECRET` | Messaging API channel |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API channel (long-lived token) |
| `SUPABASE_URL` | see "Which Supabase project?" below |
| `SUPABASE_SERVICE_ROLE_KEY` | server-side only; keep secret |
| `LINE_LOGIN_CHANNEL_ID` | verifies LIFF id tokens |
| `LIFF_ID` | initialises the LIFF web app |
| `SLIP_VENDOR` | `claude` |
| `ANTHROPIC_API_KEY` | for Claude Vision slip reading |

Do **not** add `PORT`. Do not upload `.env` (it is gitignored and never shipped).

### 4. Generate a public domain
Railway → service → **Settings → Networking → Generate Domain**. You get something like
`https://<name>.up.railway.app`. This URL is **permanent** for the service.

### 5. Point LINE at the new URL (do this yourself in the LINE console)
- **Messaging API channel → Webhook URL** → `https://<name>.up.railway.app/webhook`,
  then **Verify** and ensure "Use webhook" is on.
- **LINE Login channel → your LIFF app → Endpoint URL** →
  `https://<name>.up.railway.app/liff/`.

After this the cloudflared tunnel and the local dev server are no longer needed for
production.

---

## Which Supabase project? (decide before step 3)

The bot has been running against your current (dev) Supabase project. Two options:

- **Reuse the same project** — simplest; your existing leases/invoices carry over.
  But if you *also* leave the dev server running, two schedulers point at one DB. Pushes
  are still safe (the `job_runs` table dedupes every reminder/digest/summary), but to
  avoid confusion, **stop the local dev server** once Railway is live.
- **Separate prod project** (what `.env.example` recommends) — clean isolation. Create a
  new Supabase project, run **both** migrations in its SQL editor
  (`supabase/migrations/0001_init.sql` then `0002_job_runs.sql`), and start fresh
  (you'd re-add leases via the LIFF form).

For a first cutover, reusing the current project + stopping the dev server is the least
work.

---

## Verifying the deploy
- Railway **Deploy Logs** should show `listening on :<port> (production)` and
  `[cron] scheduler started (Asia/Bangkok): …`.
- `https://<name>.up.railway.app/health` → `{"status":"ok","env":"production"}`.
- In LINE: DM the bot `/status` (should reply), and open `/dashboard`.

## Notes
- **Migrations are not automatic.** Applying `.sql` files to Supabase is a manual step in
  the Supabase SQL editor (both `0001` and `0002` are already applied to your current
  project). Any future migration must be run there before/with the deploy that needs it.
- **Cron runs in-process**, so it only fires while the service is up. On Railway that's
  24/7. The daily 09:00 digest is skipped for any day the service was down at that minute;
  invoice generation (00:05) and the monthly summary self-heal via catch-up windows.
- Cost: a single always-on instance is roughly $5/month on Railway's usage-based plan.
