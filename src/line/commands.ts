import type { messagingApi, MessageEvent, PostbackEvent } from '@line/bot-sdk';
import { replyMessages, replyText } from './client';
import { getLandlordByLineUserId } from '../services/landlords';
import { bindGroupToLease, GroupAlreadyBoundError, listUnboundActiveLeases } from '../services/leases';
import {
  currentPeriod,
  ensureInvoicesForPeriod,
  getUnitGrid,
  monthlySummaryText,
  shiftPeriod,
  statusText,
} from '../services/views';
import { sendGroupReminders } from '../services/reminders';
import { config } from '../config';
import type { Lease, Property } from '../db/types';

const BIND_PREFIX = 'bind:';

function unitLabel(lease: Lease & { property: Property }): string {
  const p = lease.property;
  const base = [p.building, p.unit_no].filter(Boolean).join(' ') || p.name || lease.tenant_name;
  return base.length > 20 ? `${base.slice(0, 19)}…` : base; // quick-reply label cap is 20 chars
}

/** Route a text command (message beginning with '/'). */
export async function handleCommand(event: MessageEvent, text: string): Promise<void> {
  if (event.replyToken === undefined) return;
  const command = text.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? '';

  switch (command) {
    case 'setup':
      return handleSetup(event);
    case 'status':
      return handleStatus(event);
    case 'summary':
      return handleSummary(event);
    case 'remind':
      return handleRemind(event);
    case 'dashboard':
      return handleDashboard(event);
    case 'help':
      return replyText(
        event.replyToken,
        'Commands:\n' +
          '/setup — link this group to one of your units\n' +
          '/status — current period, all units (1:1 chat only)\n' +
          '/summary — last month rollup (1:1 chat only)\n' +
          '/remind — send rent reminders to groups with unpaid, due rent (1:1 chat only)\n' +
          '/dashboard — open the web dashboard\n\n' +
          'Expenses (1:1 chat only): send a payment-slip photo, ' +
          'or type an amount like "500 ค่าส่วนกลาง"',
      );
    default:
      return replyText(event.replyToken, `Unknown command: /${command}`);
  }
}

/**
 * Owner-privacy guard: tenants sit in the group chats, so figures must never
 * appear there. Returns the landlord only when we're in a 1:1 chat.
 */
async function requireOwnerDm(
  event: MessageEvent,
  replyToken: string,
): Promise<{ id: string } | null> {
  if (event.source.type !== 'user') {
    await replyText(
      replyToken,
      'ข้อมูลสถานะเป็นความลับของเจ้าของห้อง กรุณาพิมพ์คำสั่งนี้ในแชทส่วนตัวกับบอทครับ 🙏',
    );
    return null;
  }
  const landlord = await getLandlordByLineUserId(event.source.userId);
  if (!landlord) {
    await replyText(replyToken, 'ยังไม่พบข้อมูลของคุณ — เปิดแอปแล้วเพิ่มสัญญาเช่าก่อนครับ');
    return null;
  }
  return landlord;
}

/** /status — every unit's current-period position (spec §7.1). 1:1 only. */
async function handleStatus(event: MessageEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;
  const landlord = await requireOwnerDm(event, replyToken);
  if (!landlord) return;

  const period = currentPeriod();
  await ensureInvoicesForPeriod(landlord.id, period);
  const grid = await getUnitGrid(landlord.id, period);
  return replyText(replyToken, statusText(grid));
}

/** /summary — last month's rollup, the manual trigger for the Phase-5 cron. 1:1 only. */
async function handleSummary(event: MessageEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;
  const landlord = await requireOwnerDm(event, replyToken);
  if (!landlord) return;

  const period = shiftPeriod(currentPeriod(), -1);
  await ensureInvoicesForPeriod(landlord.id, period);
  const grid = await getUnitGrid(landlord.id, period);
  return replyText(replyToken, monthlySummaryText(grid));
}

/**
 * /remind — push the Thai rent reminder into every bound group whose invoice
 * is due/overdue and unpaid. Owner-triggered by design (spec §10: landlord in
 * the loop); each invoice is nudged at most once per day.
 */
async function handleRemind(event: MessageEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;
  const landlord = await requireOwnerDm(event, replyToken);
  if (!landlord) return;

  const { sent, total } = await sendGroupReminders(landlord.id);
  if (total === 0) return replyText(replyToken, 'ไม่มีห้องค้างชำระที่ถึงกำหนดครับ 🎉');
  if (sent === 0) return replyText(replyToken, 'วันนี้แจ้งเตือนครบทุกห้องแล้ว ส่งซ้ำได้พรุ่งนี้ครับ');
  return replyText(replyToken, `✓ ส่งแจ้งเตือนแล้ว ${sent}/${total} ห้อง`);
}

/** /dashboard — hand out the LIFF dashboard link (opens in LINE's in-app browser). */
async function handleDashboard(event: MessageEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;
  if (!config.LIFF_ID) return replyText(replyToken, 'Dashboard is not configured yet (missing LIFF_ID).');
  return replyText(replyToken, `📈 Dashboard:\nhttps://liff.line.me/${config.LIFF_ID}/dashboard/`);
}

async function handleSetup(event: MessageEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;

  if (event.source.type !== 'group') {
    return replyText(replyToken, 'Run /setup inside the tenant’s group chat to link it to a unit.');
  }
  const userId = event.source.userId;
  if (!userId) {
    return replyText(replyToken, 'I can’t identify you here. Add the bot as a friend, then try /setup again.');
  }

  const landlord = await getLandlordByLineUserId(userId);
  if (!landlord) {
    return replyText(replyToken, 'Open the app and add a lease first, then run /setup to link this group.');
  }

  const leases = await listUnboundActiveLeases(landlord.id);
  if (leases.length === 0) {
    return replyText(replyToken, 'No unlinked units found. Add a lease in the app first (or all your units are already linked).');
  }

  const items: messagingApi.QuickReplyItem[] = leases.slice(0, 13).map((lease) => ({
    type: 'action',
    action: {
      type: 'postback',
      label: unitLabel(lease),
      data: `${BIND_PREFIX}${lease.id}`,
      displayText: `Link this group to ${unitLabel(lease)}`,
    },
  }));

  await replyMessages(replyToken, [
    { type: 'text', text: 'Which unit is this group? Tap one:', quickReply: { items } },
  ]);
}

/** Handle the postback fired when the landlord taps a unit in the /setup list. */
export async function handlePostback(event: PostbackEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;
  const data = event.postback.data;
  if (!data.startsWith(BIND_PREFIX)) return;

  const leaseId = data.slice(BIND_PREFIX.length);
  if (event.source.type !== 'group') {
    return replyText(replyToken, 'Linking only works inside a group chat.');
  }
  const userId = event.source.userId;
  if (!userId) return replyText(replyToken, 'I can’t identify you here.');

  const landlord = await getLandlordByLineUserId(userId);
  if (!landlord) return replyText(replyToken, 'Only the unit owner can link this group.');

  try {
    const lease = await bindGroupToLease(leaseId, event.source.groupId, landlord.id);
    const p = lease.property;
    const unit = [p.building, p.unit_no].filter(Boolean).join(' ') || p.name || lease.tenant_name;
    await replyText(
      replyToken,
      `✓ Linked — this group is now ${unit} (tenant: ${lease.tenant_name}).\nSlips posted here will be matched to this unit’s invoices.`,
    );
  } catch (err) {
    if (err instanceof GroupAlreadyBoundError) {
      return replyText(replyToken, 'This group is already linked to another unit.');
    }
    return replyText(replyToken, err instanceof Error ? err.message : 'Could not link this group.');
  }
}
