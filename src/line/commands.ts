import type { messagingApi, MessageEvent, PostbackEvent } from '@line/bot-sdk';
import { pushMessage, replyMessages, replyText } from './client';
import { getLandlordByLineUserId } from '../services/landlords';
import { bindGroupToLease, GroupAlreadyBoundError, listUnboundActiveLeases } from '../services/leases';
import { propertyLabel } from '../services/labels';
import {
  bangkokToday,
  currentPeriod,
  ensureInvoicesForPeriod,
  getUnitGrid,
  monthlySummaryText,
  shiftPeriod,
  statusText,
} from '../services/views';
import {
  findReminderTargets,
  sendGroupReminders,
  sendGroupRemindersForLease,
  type ReminderTarget,
} from '../services/reminders';
import { config } from '../config';
import type { Lease, Property } from '../db/types';

const BIND_PREFIX = 'bind:';
// Owner's answer to the "send this reminder into the tenant group?" prompt.
const REMIND_APPROVE_PREFIX = 'grem:'; // grem:<leaseId>
const REMIND_DECLINE_PREFIX = 'grno:'; // grno:<leaseId>

// Avatar "connected" card served from public/ (see @fastify/static). The ratio
// must match the cropped image (see scripts/setup-cards.ts).
const CONNECTED_IMAGE_PATH = 'stickers/setup-connected-v2.png'; // versioned: LINE caches hero images by URL
const CONNECTED_IMAGE_RATIO = '718:580';

/**
 * The bind-success reply: the avatar "connected" card when a public image URL is
 * configured, otherwise plain text. altText mirrors the original plain message so
 * notifications and non-Flex clients lose nothing.
 */
function connectedMessage(unit: string, tenantName: string): messagingApi.Message {
  const alt =
    `✓ เชื่อมสำเร็จ — กลุ่มนี้คือ ${unit} (ผู้เช่า: ${tenantName}) แล้วครับ\n` +
    'สลิปที่ส่งในกลุ่มนี้จะถูกจับคู่กับบิลของห้องนี้';
  if (!config.PUBLIC_BASE_URL) return { type: 'text', text: alt };
  return {
    type: 'flex',
    altText: alt,
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: `${config.PUBLIC_BASE_URL}/${CONNECTED_IMAGE_PATH}`,
        size: 'full',
        aspectRatio: CONNECTED_IMAGE_RATIO,
        aspectMode: 'cover',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: 'เชื่อมสำเร็จแล้ว', weight: 'bold', size: 'xl', color: '#2E7D32', wrap: true },
          { type: 'text', text: `กลุ่มนี้คือ ${unit}`, size: 'md', color: '#333333', wrap: true },
          { type: 'text', text: `ผู้เช่า: ${tenantName}`, size: 'sm', color: '#555555', wrap: true },
          {
            type: 'text',
            text: 'สลิปที่ส่งในกลุ่มนี้จะถูกจับคู่กับบิลของห้องนี้',
            size: 'sm',
            color: '#8A8A8A',
            wrap: true,
            margin: 'md',
          },
        ],
      },
    },
  };
}

function unitLabel(lease: Lease & { property: Property }): string {
  const base = propertyLabel(lease.property) || lease.tenant_name;
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
        'คำสั่งที่ใช้ได้:\n' +
          '/setup — เชื่อมกลุ่มนี้กับห้องของคุณ\n' +
          '/status — สถานะงวดปัจจุบันของทุกห้อง (แชทส่วนตัวเท่านั้น)\n' +
          '/summary — สรุปยอดเดือนที่แล้ว (แชทส่วนตัวเท่านั้น)\n' +
          '/remind — ส่งแจ้งเตือนค่าเช่าไปยังกลุ่มที่ค้างชำระและถึงกำหนด (แชทส่วนตัวเท่านั้น)\n' +
          '/dashboard — เปิดแดชบอร์ดบนเว็บ\n\n' +
          'บันทึกรายรับ/รายจ่าย (แชทส่วนตัวเท่านั้น): ส่งรูปสลิปการชำระเงิน ' +
          'หรือพิมพ์จำนวนเงิน เช่น "500 ค่าส่วนกลาง"\n\n' +
          'หรือแตะเมนูด้านล่างเพื่อใช้งานทุกฟังก์ชันได้เลยครับ 👇',
      );
    default:
      return replyText(event.replyToken, `ไม่รู้จักคำสั่ง: /${command}`);
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
  if (!config.LIFF_ID) return replyText(replyToken, 'ยังไม่ได้ตั้งค่าแดชบอร์ด (ไม่พบ LIFF_ID) ครับ');
  return replyText(replyToken, `📈 แดชบอร์ด:\nhttps://liff.line.me/${config.LIFF_ID}/dashboard/`);
}

async function handleSetup(event: MessageEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;

  if (event.source.type !== 'group') {
    return replyText(replyToken, 'พิมพ์ /setup ในกลุ่มแชทของผู้เช่า เพื่อเชื่อมกลุ่มกับห้องครับ');
  }
  const userId = event.source.userId;
  if (!userId) {
    return replyText(replyToken, 'ไม่สามารถระบุตัวตนของคุณได้ กรุณาเพิ่มบอทเป็นเพื่อนก่อน แล้วพิมพ์ /setup อีกครั้งครับ');
  }

  const landlord = await getLandlordByLineUserId(userId);
  if (!landlord) {
    return replyText(replyToken, 'กรุณาเปิดแอปแล้วเพิ่มสัญญาเช่าก่อน จากนั้นพิมพ์ /setup เพื่อเชื่อมกลุ่มนี้ครับ');
  }

  const leases = await listUnboundActiveLeases(landlord.id);
  if (leases.length === 0) {
    return replyText(replyToken, 'ไม่พบห้องที่ยังไม่ได้เชื่อม กรุณาเพิ่มสัญญาเช่าในแอปก่อน (หรือทุกห้องของคุณเชื่อมครบแล้ว) ครับ');
  }

  const items: messagingApi.QuickReplyItem[] = leases.slice(0, 13).map((lease) => ({
    type: 'action',
    action: {
      type: 'postback',
      label: unitLabel(lease),
      data: `${BIND_PREFIX}${lease.id}`,
      displayText: `เชื่อมกลุ่มนี้กับ ${unitLabel(lease)}`,
    },
  }));

  await replyMessages(replyToken, [
    { type: 'text', text: 'กลุ่มนี้คือห้องไหนครับ? แตะเลือกหนึ่งห้อง:', quickReply: { items } },
  ]);
}

/** Handle the postback fired when the landlord taps a unit in the /setup list. */
export async function handlePostback(event: PostbackEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;
  const data = event.postback.data;

  if (data.startsWith(REMIND_APPROVE_PREFIX)) {
    return handleReminderApprove(event, data.slice(REMIND_APPROVE_PREFIX.length));
  }
  if (data.startsWith(REMIND_DECLINE_PREFIX)) {
    return replyText(
      replyToken,
      'รับทราบครับ ยังไม่ส่งแจ้งเตือน — พิมพ์ /remind หรือกดเมนูแจ้งเตือนค่าเช่าเมื่อต้องการส่งได้เลยครับ',
    );
  }
  if (!data.startsWith(BIND_PREFIX)) return;

  const leaseId = data.slice(BIND_PREFIX.length);
  if (event.source.type !== 'group') {
    return replyText(replyToken, 'การเชื่อมกลุ่มทำได้ในกลุ่มแชทเท่านั้นครับ');
  }
  const userId = event.source.userId;
  if (!userId) return replyText(replyToken, 'ไม่สามารถระบุตัวตนของคุณได้ครับ');

  const landlord = await getLandlordByLineUserId(userId);
  if (!landlord) return replyText(replyToken, 'เฉพาะเจ้าของห้องเท่านั้นที่เชื่อมกลุ่มนี้ได้ครับ');

  try {
    const lease = await bindGroupToLease(leaseId, event.source.groupId, landlord.id);
    const p = lease.property;
    const unit = propertyLabel(p) || lease.tenant_name;

    // Confirm the binding in the group — but never post an overdue notice there
    // unprompted. If a bill is already due/overdue, ask the OWNER privately first
    // (landlord-in-the-loop, spec §10); they choose whether to nudge the tenants.
    await replyMessages(replyToken, [connectedMessage(unit, lease.tenant_name)]);

    const target = (
      await findReminderTargets(bangkokToday(), { cadenceOnly: false, landlordId: landlord.id })
    ).find((t) => t.lease.id === lease.id);
    if (target && landlord.line_user_id) {
      await pushMessage(landlord.line_user_id, reminderApprovalPrompt(target)).catch((e) =>
        console.error('[setup] owner reminder prompt failed', e),
      );
    }
  } catch (err) {
    if (err instanceof GroupAlreadyBoundError) {
      return replyText(replyToken, 'กลุ่มนี้เชื่อมกับห้องอื่นอยู่แล้วครับ');
    }
    return replyText(replyToken, err instanceof Error ? err.message : 'เชื่อมกลุ่มนี้ไม่สำเร็จครับ');
  }
}

/**
 * Private prompt to the owner asking whether to push a due/overdue reminder into
 * the tenant group. Sent to the owner's 1:1 chat so tenants never see an overdue
 * notice until the owner approves it.
 */
function reminderApprovalPrompt(t: ReminderTarget): messagingApi.TextMessage {
  const timing = t.daysLate === 0 ? 'ครบกำหนดวันนี้' : `เลยกำหนดมา ${t.daysLate} วัน`;
  const baht = `฿${Number(t.remaining).toLocaleString('en-US')}`;
  return {
    type: 'text',
    text:
      `🔔 ${t.unit} (ผู้เช่า: ${t.lease.tenant_name})\n` +
      `มียอดค้าง ${baht} (${timing})\n` +
      'ส่งแจ้งเตือนเข้ากลุ่มผู้เช่าเลยไหมครับ?',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: 'ส่งเข้ากลุ่มเลย',
            data: `${REMIND_APPROVE_PREFIX}${t.lease.id}`,
            displayText: 'ส่งแจ้งเตือนเข้ากลุ่ม',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: 'ยังไม่ส่ง',
            data: `${REMIND_DECLINE_PREFIX}${t.lease.id}`,
            displayText: 'ยังไม่ส่ง',
          },
        },
      ],
    },
  };
}

/** Owner tapped "ส่งเข้ากลุ่มเลย" — push the reminder card into the tenant group. */
async function handleReminderApprove(event: PostbackEvent, leaseId: string): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;
  if (event.source.type !== 'user') {
    return replyText(replyToken, 'ยืนยันการส่งได้ในแชทส่วนตัวกับบอทเท่านั้นครับ');
  }
  const landlord = await getLandlordByLineUserId(event.source.userId);
  if (!landlord) return replyText(replyToken, 'ยังไม่พบข้อมูลของคุณครับ');

  const { sent, total } = await sendGroupRemindersForLease(landlord.id, leaseId);
  if (total === 0) return replyText(replyToken, 'ยอดค้างถูกชำระแล้ว หรือไม่มีรายการที่ต้องแจ้งเตือนของห้องนี้ครับ');
  if (sent === 0) return replyText(replyToken, 'วันนี้แจ้งเตือนห้องนี้ไปแล้วครับ');
  return replyText(replyToken, '✓ ส่งแจ้งเตือนเข้ากลุ่มผู้เช่าแล้วครับ');
}
