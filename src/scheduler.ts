import { db } from './db/client';
import { pushText } from './line/client';
import { notifyError } from './services/alerts';
import { jobRunsTableExists, claimJobKey } from './services/jobs';
import { sendReminderDigests } from './services/reminders';
import {
  bangkokToday,
  currentPeriod,
  ensureInvoicesForPeriod,
  getUnitGrid,
  monthlySummaryText,
  shiftPeriod,
} from './services/views';
import type { Landlord } from './db/types';

// ─────────────────────────────────────────────────────────────
// Phase 5 — in-process cron on Thai wall-clock time. Ticks every
// minute; a job fires the first tick at/after its target time.
// Job-level dedupe is in-memory and marked only on SUCCESS, so a
// failed job retries next tick and a restart re-runs at most one
// idempotent pass; every actual LINE push is additionally deduped
// in the job_runs table, so nothing is ever sent twice.
// ─────────────────────────────────────────────────────────────

function bangkokTime(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

async function listLandlords(): Promise<Landlord[]> {
  const { data, error } = await db.from('landlords').select();
  if (error) throw new Error(`listLandlords: ${error.message}`);
  return (data ?? []) as Landlord[];
}

interface Job {
  name: string;
  at: string; // 'HH:mm' Bangkok
  run(today: string): Promise<void>;
}

const JOBS: Job[] = [
  {
    // Open the new billing period for every active lease (idempotent upsert).
    name: 'invoice_gen',
    at: '00:05',
    async run() {
      const period = currentPeriod();
      for (const l of await listLandlords()) await ensureInvoicesForPeriod(l.id, period);
    },
  },
  {
    // Data hygiene: open + past-due → overdue (views compute lateness on read
    // anyway; this keeps the stored status honest for ad-hoc queries).
    name: 'mark_overdue',
    at: '00:10',
    async run(today) {
      const { error } = await db
        .from('invoices')
        .update({ status: 'overdue' })
        .eq('status', 'open')
        .lt('due_date', today);
      if (error) throw new Error(`mark_overdue: ${error.message}`);
    },
  },
  {
    // Landlord-in-the-loop reminders: digest DM on cadence days; the owner
    // sends the actual group nudges with /remind.
    name: 'reminder_digest',
    at: '09:00',
    run: sendReminderDigests,
  },
  {
    // Last month's rollup, pushed on the 1st (catch-up window: first 7 days
    // in case the box was off — summary:<landlord>:<period> dedupes).
    name: 'monthly_summary',
    at: '09:05',
    async run(today) {
      if (Number(today.slice(8, 10)) > 7) return;
      const period = shiftPeriod(currentPeriod(), -1);
      for (const l of await listLandlords()) {
        // Skip BEFORE claiming the job key: an unlinked owner can still get
        // this period's summary if they link LINE within the catch-up window.
        if (!l.line_user_id) continue;
        if (!(await claimJobKey(`summary:${l.id}:${period}`))) continue;
        await ensureInvoicesForPeriod(l.id, period);
        const grid = await getUnitGrid(l.id, period);
        await pushText(l.line_user_id, monthlySummaryText(grid));
        console.log(`[cron] monthly_summary ${period} → landlord ${l.id}`);
      }
    },
  },
];

const done = new Set<string>(); // job-level "ran today" marks (success only)

async function tick(): Promise<void> {
  const today = bangkokToday();
  const time = bangkokTime();
  for (const job of JOBS) {
    const key = `${job.name}:${today}`;
    if (time < job.at || done.has(key)) continue;
    try {
      await job.run(today);
      done.add(key);
      console.log(`[cron] ${job.name} ok (${today})`);
    } catch (err) {
      console.error(`[cron] ${job.name} failed — will retry next tick`, err);
      void notifyError(`cron:${job.name}`, err);
    }
  }
  // keep the set from growing forever
  if (done.size > 100) {
    for (const k of done) if (!k.endsWith(today)) done.delete(k);
  }
}

export async function startScheduler(): Promise<void> {
  if (!(await jobRunsTableExists())) {
    console.error(
      '[cron] job_runs table missing — apply supabase/migrations/0002_job_runs.sql. Scheduler DISABLED.',
    );
    return;
  }
  setInterval(() => void tick(), 60_000).unref();
  void tick();
  console.log('[cron] scheduler started (Asia/Bangkok):', JOBS.map((j) => `${j.name}@${j.at}`).join(', '));
}
