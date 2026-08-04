import type { messagingApi, MessageEvent, PostbackEvent } from '@line/bot-sdk';
import { pushMessage, replyMessages, replyText } from './client';
import { getLandlordByLineUserId } from '../services/landlords';
import {
  bindGroupToLease,
  findActiveLeaseByGroup,
  GroupAlreadyBoundError,
  listUnboundActiveLeases,
  unbindLease,
} from '../services/leases';
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
import { isAdminUser } from './admin';
import { createInviteCode, INVITE_EXPIRY_HOURS } from '../services/invites';
import type { Lease, Property } from '../db/types';

const BIND_PREFIX = 'bind:';
// Owner's answer to the "send this reminder into the tenant group?" prompt.
const REMIND_APPROVE_PREFIX = 'grem:'; // grem:<leaseId>
const REMIND_DECLINE_PREFIX = 'grno:'; // grno:<leaseId>
// /unbind confirmation. Exported: the kick alert (groupGate) reuses the same
// postback so the admin can free a binding from their 1:1 chat.
export const UNBIND_PREFIX = 'unb:'; // unb:<leaseId>
const UNBIND_CANCEL = 'unbx';

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

/** Full property name (no truncation) — for message text where there's no length cap. */
function unitName(lease: Lease & { property: Property }): string {
  return propertyLabel(lease.property) || lease.tenant_name;
}

/** Same name but capped to LINE's 20-char quick-reply *button* label limit. */
function unitLabel(lease: Lease & { property: Property }): string {
  const base = unitName(lease);
  return base.length > 20 ? `${base.slice(0, 19)}…` : base;
}

/** Route a text command (message beginning with '/'). */
export async function handleCommand(event: MessageEvent, text: string): Promise<void> {
  if (event.replyToken === undefined) return;
  const command = text.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? '';

  switch (command) {
    case 'setup':
      return handleSetup(event);
    case 'unbind':
      return handleUnbind(event);
    case 'status':
      return handleStatus(event);
    case 'summary':
      return handleSummary(event);
    case 'remind':
      return handleRemind(event);
    case 'dashboard':
      return handleDashboard(event);
    case 'invite':
      return handleInvite(event);
    case 'help': {
      const adminHelp = isAdminUser(event.source.type === 'user' ? event.source.userId : undefined)
        ? '\n\nคำสั่งแอดมิน:\n' +
          '/invite — สร้างรหัสเชิญสำหรับสมาชิกใหม่ (แชทส่วนตัวเท่านั้น)\n' +
          '/unbind — ยกเลิกการเชื่อมกลุ่มกับห้อง (พิมพ์ในกลุ่มที่เชื่อมอยู่)'
        : '';
      return replyText(
        event.replyToken,
        'คำสั่งที่ใช้ได้:\n' +
          '/setup — เชื่อมกลุ่มนี้กับห้องของคุณ (เฉพาะแอดมิน)\n' +
          '/status — สถานะงวดปัจจุบันของทุกห้อง (แชทส่วนตัวเท่านั้น)\n' +
          '/summary — สรุปยอดเดือนที่แล้ว (แชทส่วนตัวเท่านั้น)\n' +
          '/remind — ส่งแจ้งเตือนค่าเช่าไปยังกลุ่มที่ค้างชำระและถึงกำหนด (แชทส่วนตัวเท่านั้น)\n' +
          '/dashboard — เปิดแดชบอร์ดบนเว็บ\n\n' +
          'บันทึกรายรับ/รายจ่าย (แชทส่วนตัวเท่านั้น): ส่งรูปสลิปการชำระเงิน ' +
          'หรือพิมพ์จำนวนเงิน เช่น "500 ค่าส่วนกลาง"\n\n' +
          'หรือแตะเมนูด้านล่างเพื่อใช้งานทุกฟังก์ชันได้เลยครับ 👇' +
          adminHelp,
      );
    }
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

/** /invite — admin mints a single-use code that lets a new family member pass the 1:1 gate. */
async function handleInvite(event: MessageEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;

  if (event.source.type !== 'user') {
    return replyText(replyToken, 'สร้างรหัสเชิญได้ในแชทส่วนตัวกับบอทเท่านั้นครับ');
  }
  if (!config.ADMIN_LINE_USER_ID) {
    return replyText(replyToken, 'ยังไม่ได้ตั้งค่าแอดมิน (ADMIN_LINE_USER_ID) ในเซิร์ฟเวอร์ครับ');
  }
  if (!isAdminUser(event.source.userId)) {
    return replyText(replyToken, 'ขออภัยครับ เฉพาะแอดมินเท่านั้นที่สร้างรหัสเชิญได้');
  }

  const invite = await createInviteCode(event.source.userId);
  return replyText(
    replyToken,
    `🔑 รหัสเชิญ: ${invite.code}\n\n` +
      'ส่งรหัสนี้ให้สมาชิกในครอบครัว แล้วให้:\n' +
      '1. เพิ่มบอทเป็นเพื่อน\n' +
      '2. พิมพ์รหัสนี้ในแชทส่วนตัวกับบอท\n\n' +
      `(ใช้ได้ครั้งเดียว หมดอายุใน ${INVITE_EXPIRY_HOURS} ชั่วโมง)`,
  );
}

/**
 * /unbind — typed in a bound group (unbound groups never reach here: the
 * Layer-1 gate ignores them). Confirm-first so a stray message can't detach a
 * tenant group. The bot stays in the group afterwards — the admin can /setup
 * a different unit or remove the bot manually.
 */
async function handleUnbind(event: MessageEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;

  if (event.source.type !== 'group') {
    return replyText(replyToken, 'พิมพ์ /unbind ในกลุ่มที่ต้องการยกเลิกการเชื่อมครับ');
  }
  if (!isAdminUser(event.source.userId)) {
    return replyText(replyToken, 'ขออภัยครับ เฉพาะแอดมินเท่านั้นที่ยกเลิกการเชื่อมได้');
  }

  const bound = await findActiveLeaseByGroup(event.source.groupId);
  if (!bound) {
    return replyText(replyToken, 'กลุ่มนี้ยังไม่ได้เชื่อมกับห้องครับ');
  }
  const unit = propertyLabel(bound.property) || bound.lease.tenant_name;

  return replyMessages(replyToken, [
    {
      type: 'text',
      text:
        `ยืนยันยกเลิกการเชื่อมกลุ่มนี้กับ ${unit} (ผู้เช่า: ${bound.lease.tenant_name}) ใช่ไหมครับ?\n` +
        'สลิปที่ส่งในกลุ่มนี้จะไม่ถูกจับคู่กับบิลอีก จนกว่าจะเชื่อมใหม่ด้วย /setup',
      quickReply: {
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '✅ ใช่ ยกเลิกการเชื่อม',
              data: `${UNBIND_PREFIX}${bound.lease.id}`,
              displayText: 'ใช่ ยกเลิกการเชื่อม',
            },
          },
          {
            type: 'action',
            action: { type: 'postback', label: '❌ ไม่ยกเลิก', data: UNBIND_CANCEL, displayText: 'ไม่ยกเลิก' },
          },
        ],
      },
    },
  ]);
}

/** Admin confirmed /unbind (in the group) or tapped the kick-alert button (1:1). */
async function handleUnbindConfirm(event: PostbackEvent, leaseId: string): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined) return;
  if (!isAdminUser(event.source.userId)) {
    return replyText(replyToken, 'ขออภัยครับ เฉพาะแอดมินเท่านั้นที่ยกเลิกการเชื่อมได้');
  }

  // In-group tap must match the group it was issued in (stale-button guard);
  // a 1:1 tap (kick alert) unbinds wherever the lease is currently bound.
  const requireGroupId = event.source.type === 'group' ? event.source.groupId : undefined;
  const lease = await unbindLease(leaseId, requireGroupId);
  if (!lease) {
    return replyText(replyToken, 'ไม่พบการเชื่อมนี้แล้วครับ (อาจถูกยกเลิกไปก่อนหน้านี้)');
  }
  const unit = propertyLabel(lease.property) || lease.tenant_name;
  console.log(`[unbind] lease ${lease.id} (${unit}) detached from its group`);
  return replyText(
    replyToken,
    `✓ ยกเลิกการเชื่อมกับ ${unit} แล้วครับ\n` +
      'ห้องนี้กลับไปอยู่ในรายการ /setup — เชื่อมกลุ่มใหม่ได้ทุกเมื่อครับ',
  );
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
  if (!config.ADMIN_LINE_USER_ID) {
    return replyText(replyToken, 'ยังไม่ได้ตั้งค่าแอดมิน (ADMIN_LINE_USER_ID) ในเซิร์ฟเวอร์ครับ');
  }
  if (!isAdminUser(userId)) {
    return replyText(replyToken, 'ขออภัยครับ เฉพาะแอดมินเท่านั้นที่เชื่อมกลุ่มได้');
  }

  // Family-wide list: the admin registers groups for every member's properties.
  const leases = await listUnboundActiveLeases();
  if (leases.length === 0) {
    return replyText(replyToken, 'ไม่พบห้องที่ยังไม่ได้เชื่อม กรุณาเพิ่มสัญญาเช่าในแอปก่อน (หรือทุกห้องเชื่อมครบแล้ว) ครับ');
  }

  const items: messagingApi.QuickReplyItem[] = leases.slice(0, 13).map((lease) => ({
    type: 'action',
    action: {
      type: 'postback',
      label: unitLabel(lease), // button label — capped at LINE's 20-char limit
      data: `${BIND_PREFIX}${lease.id}`,
      displayText: `เชื่อมกลุ่มนี้กับ ${unitName(lease)}`, // sent message — full name, no cap
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

  if (data.startsWith(UNBIND_PREFIX)) {
    return handleUnbindConfirm(event, data.slice(UNBIND_PREFIX.length));
  }
  if (data === UNBIND_CANCEL) {
    return replyText(replyToken, 'รับทราบครับ กลุ่มนี้ยังเชื่อมกับห้องเดิมอยู่');
  }
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

  // Quick-reply buttons are visible to everyone in the group — re-check that
  // the tap actually came from the admin, not a curious tenant.
  if (!isAdminUser(userId)) {
    return replyText(replyToken, 'ขออภัยครับ เฉพาะแอดมินเท่านั้นที่เชื่อมกลุ่มได้');
  }

  try {
    const lease = await bindGroupToLease(leaseId, event.source.groupId);
    const p = lease.property;
    const unit = propertyLabel(p) || lease.tenant_name;

    // Confirm the binding in the group — but never post an overdue notice there
    // unprompted. If a bill is already due/overdue, ask the unit's OWNER privately
    // first (landlord-in-the-loop, spec §10) — the owner, not the admin doing the
    // binding, since /remind approval is scoped to the owner's own leases.
    await replyMessages(replyToken, [connectedMessage(unit, lease.tenant_name)]);

    const owner = lease.property.landlord;
    const target = (
      await findReminderTargets(bangkokToday(), { cadenceOnly: false, landlordId: owner.id })
    ).find((t) => t.lease.id === lease.id);
    if (target && owner.line_user_id) {
      await pushMessage(owner.line_user_id, reminderApprovalPrompt(target)).catch((e) =>
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
