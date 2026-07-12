import { config } from '../config';
import { pushText } from '../line/client';

// ─────────────────────────────────────────────────────────────
// Ops alerting. The bot runs unattended in production, so the two
// out-of-band failure paths (webhook event handling and the cron
// jobs) would otherwise fail silently — a tenant's slip gets no
// reply and nobody knows. notifyError() DMs the operator instead.
//
// Best-effort by contract: it never throws, so a broken alert can
// never take down the caller. Requires ADMIN_LINE_USER_ID; without
// it, callers still log and this is a no-op.
// ─────────────────────────────────────────────────────────────

/** Per-context cooldown so a repeating fault (e.g. DB down) can't spam LINE pushes. */
const COOLDOWN_MS = 10 * 60 * 1000;
const lastSentAt = new Map<string, number>();

function bangkokTimestamp(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date());
}

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const line = msg.split('\n')[0] ?? '';
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/**
 * Report an unexpected error to the operator over LINE. `context` labels the
 * source (e.g. "webhook", "cron:reminder_digest") and also keys the cooldown.
 */
export async function notifyError(context: string, err: unknown): Promise<void> {
  const adminId = config.ADMIN_LINE_USER_ID;
  if (!adminId) return;

  const now = Date.now();
  const last = lastSentAt.get(context) ?? 0;
  if (now - last < COOLDOWN_MS) return; // still cooling down for this context
  lastSentAt.set(context, now);

  const text = `⚠️ Bot error [${context}] ${bangkokTimestamp()}\n${firstLine(err)}`;
  try {
    await pushText(adminId, text);
  } catch (pushErr) {
    // The alert channel itself failed — log and give up; never rethrow.
    console.error('[alerts] failed to deliver error alert:', pushErr);
  }
}
