import type { PostbackEvent, messagingApi } from '@line/bot-sdk';
import { replyMessages, replyText } from './client';
import { getLandlordByLineUserId } from '../services/landlords';
import { bangkokToday } from '../services/views';
import {
  findReminderTargets,
  sendGroupReminders,
  sendGroupRemindersForLease,
  type ReminderTarget,
} from '../services/reminders';

// ─────────────────────────────────────────────────────────────
// Rich menu postbacks. The menu is the channel default, so anyone
// who friends the bot can tap it — every branch re-checks that the
// tapper is a known landlord before touching data.
//
// Postback data formats (≤300 chars per LINE):
//   menu:txn         — "record income/expense" cell
//   menu:remind      — "remind tenants" cell
//   rmd:<leaseId>    — reminder picker: one lease's group
//   rmd:all          — reminder picker: every due/overdue group
// ─────────────────────────────────────────────────────────────

export const MENU_PREFIX = 'menu:';
export const REMIND_PREFIX = 'rmd:';

export function isMenuPostback(data: string): boolean {
  return data.startsWith(MENU_PREFIX) || data.startsWith(REMIND_PREFIX);
}

const quickLabel = (s: string) => (s.length > 20 ? `${s.slice(0, 19)}…` : s); // LINE cap

export async function handleMenuPostback(event: PostbackEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined || event.source.type !== 'user') return;

  const landlord = await getLandlordByLineUserId(event.source.userId);
  if (!landlord) {
    return replyText(replyToken, 'ยังไม่พบข้อมูลของคุณ — เปิดแอปแล้วเพิ่มสัญญาเช่าก่อนครับ');
  }

  const data = event.postback.data;
  try {
    if (data === `${MENU_PREFIX}txn`) {
      return replyText(
        replyToken,
        'พิมพ์จำนวนเงินที่ต้องการบันทึกได้เลยครับ เช่น "500" หรือ "500 ค่าส่วนกลาง"\nหรือส่งรูปสลิปก็ได้ครับ',
      );
    }
    if (data === `${MENU_PREFIX}remind`) {
      return askRemindTarget(replyToken, landlord.id);
    }
    if (data.startsWith(REMIND_PREFIX)) {
      const leaseId = data.slice(REMIND_PREFIX.length);
      if (leaseId === 'all') {
        const { sent, total } = await sendGroupReminders(landlord.id);
        if (total === 0) return replyText(replyToken, 'ไม่มีห้องค้างชำระที่ถึงกำหนดครับ 🎉');
        if (sent === 0) return replyText(replyToken, 'วันนี้แจ้งเตือนครบทุกห้องแล้ว ส่งซ้ำได้พรุ่งนี้ครับ');
        return replyText(replyToken, `✓ ส่งแจ้งเตือนแล้ว ${sent}/${total} ห้อง`);
      }
      const { sent, total } = await sendGroupRemindersForLease(landlord.id, leaseId);
      if (total === 0) return replyText(replyToken, 'ห้องนี้ไม่มียอดค้างชำระแล้วครับ 🎉');
      if (sent === 0) return replyText(replyToken, 'วันนี้แจ้งเตือนห้องนี้ไปแล้ว ส่งซ้ำได้พรุ่งนี้ครับ');
      return replyText(replyToken, '✓ ส่งแจ้งเตือนไปที่กลุ่มของห้องนี้แล้วครับ');
    }
  } catch (err) {
    console.error('[menu] postback failed', err);
    return replyText(replyToken, 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้งครับ');
  }
}

/** Quick-reply picker: which condo's group should get the rent reminder? */
async function askRemindTarget(replyToken: string, landlordId: string): Promise<void> {
  const targets = await findReminderTargets(bangkokToday(), { cadenceOnly: false, landlordId });
  if (targets.length === 0) {
    return replyText(replyToken, 'ไม่มีห้องค้างชำระที่ถึงกำหนดครับ 🎉');
  }

  // One button per lease (a lease can owe several invoices at once).
  const byLease = new Map<string, ReminderTarget>();
  for (const t of targets) if (!byLease.has(t.lease.id)) byLease.set(t.lease.id, t);

  const leases = [...byLease.values()].slice(0, 12); // 13-item quick-reply cap, minus "all"
  const items: messagingApi.QuickReplyItem[] = [
    ...leases.map((t): messagingApi.QuickReplyItem => ({
      type: 'action',
      action: {
        type: 'postback',
        label: quickLabel(t.unit),
        data: `${REMIND_PREFIX}${t.lease.id}`,
        displayText: `แจ้งเตือน ${t.unit}`,
      },
    })),
    {
      type: 'action',
      action: {
        type: 'postback',
        label: 'ทุกห้อง 🔔',
        data: `${REMIND_PREFIX}all`,
        displayText: 'แจ้งเตือนทุกห้อง',
      },
    },
  ];

  await replyMessages(replyToken, [
    { type: 'text', text: 'จะส่งแจ้งเตือนค่าเช่าไปที่กลุ่มไหนครับ?', quickReply: { items } },
  ]);
}
