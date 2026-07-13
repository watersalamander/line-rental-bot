import type { messagingApi } from '@line/bot-sdk';
import { db } from '../db/client';
import { pushMessage, pushText } from '../line/client';
import { config } from '../config';
import { claimJobKey } from './jobs';
import { propertyLabel } from './labels';
import { bangkokToday } from './views';
import type { Invoice, Landlord, Lease, Property } from '../db/types';

// Avatar reminder card served from public/ (see @fastify/static). The ratio must
// match the cropped image so the hero isn't distorted (see scripts/setup-cards.ts).
const REMINDER_IMAGE_PATH = 'stickers/rent-reminder.png';
const REMINDER_IMAGE_RATIO = '722:829';

// ─────────────────────────────────────────────────────────────
// Phase 5 — rent reminders, landlord-in-the-loop (spec §10 choice):
// the cron DMs the OWNER a digest on cadence days; only /remind
// actually posts into the tenant groups. Push dedupe via job_runs.
// ─────────────────────────────────────────────────────────────

/** Reminder cadence: due date, then every 3 days while unpaid, up to 30 days late. */
const CADENCE_DAYS = 3;
const CADENCE_CAP_DAYS = 30;

const baht = (n: number) => `฿${Number(n).toLocaleString('en-US')}`;

export interface ReminderTarget {
  invoice: Invoice;
  lease: Lease;
  property: Property;
  landlord: Landlord;
  unit: string;
  remaining: number;
  daysLate: number; // 0 = due today
}

const daysBetween = (fromYmd: string, toYmd: string): number =>
  Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / 86_400_000);

const onCadence = (daysLate: number): boolean =>
  daysLate === 0 || (daysLate > 0 && daysLate <= CADENCE_CAP_DAYS && daysLate % CADENCE_DAYS === 0);

/**
 * Unpaid invoices due on/before `today` for active, group-bound leases.
 * `cadenceOnly` restricts to the digest cadence (due day / every 3 days);
 * /remind passes false so the owner can nudge everything overdue at any time.
 */
export async function findReminderTargets(
  today: string,
  opts: { cadenceOnly: boolean; landlordId?: string },
): Promise<ReminderTarget[]> {
  const { data, error } = await db
    .from('invoices')
    .select('*, lease:leases(*, property:properties(*, landlord:landlords(*)))')
    .in('status', ['open', 'partial', 'overdue'])
    .lte('due_date', today);
  if (error) throw new Error(`findReminderTargets: ${error.message}`);

  const targets: ReminderTarget[] = [];
  for (const row of (data ?? []) as Array<Invoice & { lease: Lease & { property: Property & { landlord: Landlord } } }>) {
    const lease = row.lease;
    if (!lease || lease.status !== 'active' || !lease.line_group_id) continue;
    const { landlord, ...property } = lease.property;
    if (opts.landlordId && landlord.id !== opts.landlordId) continue;

    const remaining = Number(row.amount_due) - Number(row.paid_amount);
    if (remaining <= 0) continue;

    const daysLate = daysBetween(row.due_date, today);
    if (opts.cadenceOnly && !onCadence(daysLate)) continue;

    targets.push({
      invoice: row,
      lease,
      property: property as Property,
      landlord,
      unit: propertyLabel(property) || lease.tenant_name,
      remaining: Number(remaining.toFixed(2)),
      daysLate,
    });
  }
  return targets.sort((a, b) => b.daysLate - a.daysLate);
}

/** Thai reminder posted into the tenant group. */
export function reminderText(t: ReminderTarget): string {
  const head =
    t.daysLate === 0
      ? `🔔 แจ้งเตือนค่าเช่างวด ${t.invoice.period_month} ครบกำหนดวันนี้`
      : `🔔 แจ้งเตือนค่าเช่างวด ${t.invoice.period_month} เลยกำหนดมา ${t.daysLate} วัน`;
  return `${head}\nยอดค้าง ${baht(t.remaining)}\nโอนแล้วส่งสลิปในกลุ่มนี้ได้เลยครับ 🙏`;
}

/**
 * The polished group reminder: the avatar as a Flex hero plus the concrete
 * figures below. altText carries reminderText() so notifications and clients
 * that can't render Flex lose nothing.
 */
export function reminderFlex(t: ReminderTarget, imageUrl: string): messagingApi.FlexMessage {
  const dueToday = t.daysLate === 0;
  const timing = dueToday ? 'ครบกำหนดวันนี้' : `เลยกำหนดมา ${t.daysLate} วัน`;
  return {
    type: 'flex',
    altText: reminderText(t),
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: imageUrl,
        size: 'full',
        aspectRatio: REMINDER_IMAGE_RATIO,
        aspectMode: 'cover',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: `🔔 ค่าเช่างวด ${t.invoice.period_month}`,
            weight: 'bold',
            size: 'xl',
            color: dueToday ? '#2E7D32' : '#C62828',
            wrap: true,
          },
          { type: 'text', text: timing, size: 'sm', color: '#555555', wrap: true },
          { type: 'text', text: `ยอดค้าง ${baht(t.remaining)}`, weight: 'bold', size: 'lg', color: '#333333', wrap: true, margin: 'sm' },
          { type: 'text', text: 'โอนแล้วส่งสลิปในกลุ่มนี้ได้เลยครับ 🙏', size: 'sm', color: '#8A8A8A', wrap: true, margin: 'md' },
        ],
      },
    },
  };
}

/**
 * Group-reminder message: the Flex card when a public image URL is configured,
 * otherwise plain text (Flex heroes need a public HTTPS image URL).
 */
export function reminderMessage(t: ReminderTarget): messagingApi.Message {
  return config.PUBLIC_BASE_URL
    ? reminderFlex(t, `${config.PUBLIC_BASE_URL}/${REMINDER_IMAGE_PATH}`)
    : { type: 'text', text: reminderText(t) };
}

/** Daily DM to the owner listing units on cadence, with the /remind call-to-action. */
export function digestText(targets: ReminderTarget[], today: string): string {
  const lines = [`🔔 รายการค้างชำระ (${today})`, ''];
  for (const t of targets) {
    const when = t.daysLate === 0 ? 'ครบกำหนดวันนี้' : `เลยกำหนด ${t.daysLate} วัน`;
    lines.push(`• ${t.unit} — ${t.lease.tenant_name}: ค้าง ${baht(t.remaining)} (${when})`);
  }
  lines.push('', 'พิมพ์ /remind เพื่อส่งแจ้งเตือนเข้ากลุ่มผู้เช่าครับ');
  return lines.join('\n');
}

/**
 * Send the group reminders for one landlord (the /remind action).
 * Each invoice is reminded at most once per day (job_runs claim).
 */
export async function sendGroupReminders(
  landlordId: string,
  today = bangkokToday(),
): Promise<{ sent: number; total: number }> {
  const targets = await findReminderTargets(today, { cadenceOnly: false, landlordId });
  let sent = 0;
  for (const t of targets) {
    if (!(await claimJobKey(`remind:${t.invoice.id}:${today}`))) continue;
    await pushMessage(t.lease.line_group_id as string, reminderMessage(t));
    console.log(`[remind] sent → ${t.unit} (${t.invoice.period_month}, ${t.daysLate}d late)`);
    sent++;
  }
  return { sent, total: targets.length };
}

/**
 * Rich-menu variant of /remind: nudge a single lease's group only.
 * Shares the per-invoice-per-day claim with sendGroupReminders, so the two
 * paths dedupe against each other. total=0 means the lease has no unpaid
 * due/overdue invoice (paid in the meantime, or never overdue).
 */
export async function sendGroupRemindersForLease(
  landlordId: string,
  leaseId: string,
  today = bangkokToday(),
): Promise<{ sent: number; total: number }> {
  const targets = (await findReminderTargets(today, { cadenceOnly: false, landlordId })).filter(
    (t) => t.lease.id === leaseId,
  );
  let sent = 0;
  for (const t of targets) {
    if (!(await claimJobKey(`remind:${t.invoice.id}:${today}`))) continue;
    await pushMessage(t.lease.line_group_id as string, reminderMessage(t));
    console.log(`[remind] menu sent → ${t.unit} (${t.invoice.period_month}, ${t.daysLate}d late)`);
    sent++;
  }
  return { sent, total: targets.length };
}

/** Cron half: DM each landlord a digest on cadence days (dedupe per landlord per day). */
export async function sendReminderDigests(today: string): Promise<void> {
  const targets = await findReminderTargets(today, { cadenceOnly: true });
  const byLandlord = new Map<string, ReminderTarget[]>();
  for (const t of targets) {
    const list = byLandlord.get(t.landlord.id) ?? [];
    list.push(t);
    byLandlord.set(t.landlord.id, list);
  }
  for (const [landlordId, list] of byLandlord) {
    const first = list[0];
    // No LINE id yet → skip before claiming, so the digest isn't burned for
    // an owner who links LINE later the same day.
    if (!first || !first.landlord.line_user_id) continue;
    if (!(await claimJobKey(`digest:${landlordId}:${today}`))) continue;
    await pushText(first.landlord.line_user_id, digestText(list, today));
    console.log(`[cron] digest → landlord ${landlordId} (${list.length} units)`);
  }
}
