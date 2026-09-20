# Deploying to AWS Lambda

The bot gets a handful of requests a month, so production runs on **AWS Lambda**
(pay-per-request, scales to zero) instead of an always-on server. At this traffic
everything sits inside AWS's always-free tier — expected cost **$0/month**.

| Piece | What it does |
| --- | --- |
| Lambda `line-rental-bot` | The whole Fastify app ([`src/lambda.ts`](src/lambda.ts)), bundled to one file by `npm run build:lambda` |
| Lambda **Function URL** | Stable public HTTPS endpoint: LINE webhook, LIFF pages, `/api`, Flex images |
| 2 × EventBridge schedules | 00:15 and 09:10 Asia/Bangkok → run the due cron jobs ([`src/scheduler.ts`](src/scheduler.ts)) |
| CloudWatch log group | `/aws/lambda/line-rental-bot`, 30-day retention |

All of it is defined in [`template.yaml`](template.yaml) (AWS SAM) and deployed by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on every push to `main`.
The database stays on Supabase — nothing changes there.

Local development is unchanged: `npm run dev` still runs the long-lived Fastify
server with the in-process scheduler.

---

## One-time setup

### 1. AWS account + deploy user
1. Create an AWS account (or use an existing one). **Set a billing alarm / budget**
   (Billing → Budgets → "Zero spend budget") so any surprise charge emails you.
2. IAM → Users → **Create user** `github-deploy` (no console access) and attach these
   managed policies: `AWSCloudFormationFullAccess`, `AWSLambda_FullAccess`,
   `IAMFullAccess`, `AmazonS3FullAccess`, `AmazonEventBridgeSchedulerFullAccess`,
   `CloudWatchLogsFullAccess`. (Simpler but broader: `AdministratorAccess`.)
3. On that user: Security credentials → **Create access key** → "Third-party service".
   Keep the key id + secret for the next step.

### 2. GitHub repo settings (Settings → Secrets and variables → Actions)

**Secrets** (same values as the Railway variables / your prod `.env`):

| Secret | Notes |
| --- | --- |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | from step 1 |
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API channel |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | production project |
| `ANTHROPIC_API_KEY` | Claude Vision slip reading |
| `EASYSLIP_TOKEN` | only if `SLIP_VENDOR=easyslip` |

**Variables** (not secret):

| Variable | Notes |
| --- | --- |
| `LINE_LOGIN_CHANNEL_ID`, `LIFF_ID` | LIFF |
| `ADMIN_LINE_USER_ID` | admin gate + error alerts |
| `AWS_REGION` | optional, default `ap-southeast-1` (Singapore) |
| `SLIP_VENDOR` | optional, default `claude` |
| `PUBLIC_BASE_URL` | leave unset for now — see step 4 |
| `AWS_DEPLOY_ENABLED` | set to `true` **last**; the workflow is dormant without it |

### 3. First deploy
Actions → **Deploy (AWS Lambda)** → *Run workflow* (or push to `main`). When it
finishes, the run summary shows the **Function URL**, e.g.
`https://abc123.lambda-url.ap-southeast-1.on.aws/`, and the final step curls
`/health`. This URL is permanent for the stack.

### 4. Set `PUBLIC_BASE_URL` and redeploy
Flex cards (slip receipt, reminder, setup) need absolute image URLs, and the URL
isn't known until the first deploy. Set the GitHub variable `PUBLIC_BASE_URL` to the
Function URL **without the trailing slash**, then run the workflow again.

### 5. Cut over from Railway (do this yourself in the LINE console)
1. **Messaging API channel → Webhook settings → make sure "Webhook redelivery" is
   OFF.** On Lambda the bot processes an event *before* acknowledging it (the
   container freezes once it responds), so a slip read can take several seconds;
   with redelivery on, LINE would re-send those slow events.
2. **Webhook URL** → `<Function URL>webhook` → **Verify**.
3. **LINE Login channel → your LIFF app → Endpoint URL** → `<Function URL>liff/`.
4. Test in LINE: `/status` in the 1:1 chat, open the dashboard from the rich menu,
   send a slip in a bound group (the receipt card should show its image).
5. Once happy, **stop/delete the Railway service** so only one scheduler exists.
   (Running both for a day is harmless — every push is deduped in `job_runs` — but
   there's no reason to keep paying.)

**Rollback:** point the webhook + LIFF endpoint back at the Railway domain. The
`Dockerfile` and `railway.json` stay in the repo for that reason; delete them once
Lambda has run cleanly for a while.

---

## How it differs from the always-on server
- **Webhook:** events are processed before the 200 is returned (see step 5.1).
  The first message after idle pays a ~1 s cold start; replies still use the free
  reply token.
- **Cron:** no per-minute tick. EventBridge invokes the function at 00:15 and 09:10
  Bangkok time and it runs every job whose time has passed. Jobs are idempotent and
  every LINE push is claimed in `job_runs`, so re-runs never double-send. A failed
  run throws, and Lambda's async retry re-invokes it (twice, a few minutes apart);
  the admin also gets the usual error DM.
- **Error-alert cooldown** is per container, so a repeating fault can DM slightly
  more often than once per 10 minutes.
- The daily cron also keeps a free-tier Supabase project from auto-pausing.

## Verifying / debugging
- `<Function URL>health` → `{"status":"ok","env":"production"}`.
- Logs: CloudWatch → Log groups → `/aws/lambda/line-rental-bot`
  (`[event] …`, `[slip] …`, `[cron] … ok`).
- Run the cron by hand: Lambda console → Test → event `{"source":"line-rental-bot.cron"}`.
- Smoke-test the bundle locally without AWS: `npm run build:lambda`, then
  `require('./lambda-dist/index.js').handler(<Function-URL-style event>, {})`.

## Notes
- **Migrations are not automatic.** Apply new `supabase/migrations/*.sql` files in the
  Supabase SQL editor before/with the deploy that needs them.
- Env vars live in the stack parameters (GitHub secrets → `sam deploy`). Editing them
  in the Lambda console works but is overwritten by the next deploy.
- To tear everything down: CloudFormation → stack `line-rental-bot` → Delete.
