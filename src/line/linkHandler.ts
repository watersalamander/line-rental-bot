import type { MessageEvent, PostbackEvent, messagingApi } from '@line/bot-sdk';
import { getUserName, replyMessages, replyText } from './client';
import {
  getLandlordByLineUserId,
  linkLandlordToLineUser,
  listUnlinkedLandlords,
  upsertLandlord,
} from '../services/landlords';
import { hasRedeemedInvite, INVITE_CODE_RE, redeemInviteCode } from '../services/invites';
import { isAdminUser } from './admin';

// ─────────────────────────────────────────────────────────────
// Identity linking: family members were imported with
// line_user_id = null, so the first time each of them talks to
// the bot we ask "who are you?" and bind their LINE account to
// the right landlord row — instead of minting a duplicate.
//
// Layer-3 gate (in front of all of it): an unknown LINE account
// gets nothing until it types a valid invite code from /invite.
// The admin account bypasses the gate; everyone else must have a
// redeemed code on record before the picker ever appears.
//
// Postback data formats:
//   lnkp:<landlordId>   name picked → ask for confirmation
//   lnkc:<landlordId>   confirmed → atomically claim the row
//   lnkx                cancelled → show the picker again
//   lnkn                "not in the list" → create a fresh profile
// ─────────────────────────────────────────────────────────────

export const LINK_PICK_PREFIX = 'lnkp:';
export const LINK_CONFIRM_PREFIX = 'lnkc:';
export const LINK_CANCEL = 'lnkx';
export const LINK_NEW = 'lnkn';

export function isLinkPostback(data: string): boolean {
  return (
    data.startsWith(LINK_PICK_PREFIX) ||
    data.startsWith(LINK_CONFIRM_PREFIX) ||
    data === LINK_CANCEL ||
    data === LINK_NEW
  );
}

const quickLabel = (s: string) => (s.length > 20 ? `${s.slice(0, 19)}…` : s); // LINE cap

/**
 * Show the "คุณคือใคร?" picker if any unlinked family rows exist.
 * Returns false when there is nothing to offer. An optional preamble
 * (e.g. "รหัสถูกต้อง") is sent as a separate line above the picker.
 */
export async function offerLinkPicker(replyToken: string, preamble?: string): Promise<boolean> {
  const unlinked = await listUnlinkedLandlords();
  if (unlinked.length === 0) return false;
  console.log(`[link] offering identity picker (${unlinked.length} unlinked)`);

  const items: messagingApi.QuickReplyItem[] = [
    ...unlinked.slice(0, 12).map((l): messagingApi.QuickReplyItem => {
      const name = l.display_name ?? '(ไม่มีชื่อ)';
      return {
        type: 'action',
        action: {
          type: 'postback',
          label: quickLabel(name),
          data: `${LINK_PICK_PREFIX}${l.id}`,
          displayText: `ฉันคือ ${name}`,
        },
      };
    }),
    {
      type: 'action',
      action: { type: 'postback', label: 'ไม่อยู่ในรายชื่อ', data: LINK_NEW, displayText: 'ไม่อยู่ในรายชื่อ' },
    },
  ];

  const picker: messagingApi.Message = {
    type: 'text',
    text: 'สวัสดีครับ 🙏 ยังไม่รู้จักบัญชี LINE นี้\nคุณคือใครครับ? แตะเลือกชื่อของคุณ:',
    quickReply: { items },
  };
  await replyMessages(
    replyToken,
    preamble ? [{ type: 'text', text: preamble }, picker] : [picker],
  );
  return true;
}

const UNINVITED_REPLY =
  'สวัสดีครับ 🙏 บอทนี้ใช้งานภายในครอบครัวเท่านั้น\n' +
  'หากคุณเป็นสมาชิก กรุณาขอ "รหัสเชิญ" จากแอดมิน แล้วพิมพ์รหัสที่ได้รับที่นี่ครับ';

/**
 * Invited-but-unlinked account: offer the identity picker, or — when no
 * unlinked family rows remain — create a fresh profile on the spot.
 * Always consumes the event.
 */
async function linkOrCreateProfile(
  replyToken: string,
  userId: string,
  preamble?: string,
): Promise<true> {
  if (await offerLinkPicker(replyToken, preamble)) return true;

  const name = await getUserName(userId);
  const landlord = await upsertLandlord(userId, name);
  console.log(`[link] new profile ${userId} → landlord ${landlord.id} (${landlord.display_name})`);
  await replyText(
    replyToken,
    `${preamble ? `${preamble}\n` : ''}✓ สร้างโปรไฟล์ใหม่ให้แล้วครับ (${landlord.display_name ?? 'ไม่มีชื่อ'})\n` +
      'พิมพ์ /help เพื่อดูคำสั่งทั้งหมดครับ',
  );
  return true;
}

/**
 * Gate for 1:1 events from accounts with no landlord row yet. Layer 3:
 * unless the sender is the admin or already redeemed an invite code, the
 * only accepted message is a valid code — everything else gets a polite
 * "internal use only" reply. Linked users pass straight through.
 */
export async function interceptUnknownUser(event: MessageEvent): Promise<boolean> {
  if (event.source.type !== 'user' || event.replyToken === undefined) return false;
  const userId = event.source.userId;
  const landlord = await getLandlordByLineUserId(userId);
  if (landlord) return false;

  if (!isAdminUser(userId) && !(await hasRedeemedInvite(userId))) {
    if (event.message.type === 'text') {
      const attempt = event.message.text.trim().toUpperCase();
      if (INVITE_CODE_RE.test(attempt) && (await redeemInviteCode(attempt, userId))) {
        console.log(`[link] ${userId} redeemed invite code ${attempt}`);
        return linkOrCreateProfile(event.replyToken, userId, '✓ รหัสเชิญถูกต้องครับ');
      }
    }
    console.log(`[link] uninvited account ${userId} — rejected`);
    await replyText(event.replyToken, UNINVITED_REPLY);
    return true;
  }

  return linkOrCreateProfile(event.replyToken, userId);
}

export async function handleLinkPostback(event: PostbackEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined || event.source.type !== 'user') return;
  const userId = event.source.userId;
  const data = event.postback.data;

  // A second tap after a successful link (or a race with the LIFF page):
  // whatever was tapped, this account is already somebody.
  const existing = await getLandlordByLineUserId(userId);
  if (existing) {
    return replyText(replyToken, `บัญชี LINE ของคุณผูกกับ «${existing.display_name ?? '?'}» อยู่แล้วครับ`);
  }

  // Layer-3 backstop: the picker is only ever sent to invited accounts, but a
  // postback is cheap to forge — re-check the invite before honoring any tap.
  if (!isAdminUser(userId) && !(await hasRedeemedInvite(userId))) {
    console.log(`[link] uninvited account ${userId} sent link postback — rejected`);
    return replyText(replyToken, UNINVITED_REPLY);
  }

  if (data.startsWith(LINK_PICK_PREFIX)) {
    const landlordId = data.slice(LINK_PICK_PREFIX.length);
    const unlinked = await listUnlinkedLandlords();
    const target = unlinked.find((l) => l.id === landlordId);
    if (!target) {
      await replyText(replyToken, 'ชื่อนี้ถูกผูกกับบัญชีอื่นไปแล้วครับ ลองเลือกใหม่อีกครั้ง');
      return;
    }
    const name = target.display_name ?? '(ไม่มีชื่อ)';
    const items: messagingApi.QuickReplyItem[] = [
      {
        type: 'action',
        action: { type: 'postback', label: '✅ ใช่ ยืนยัน', data: `${LINK_CONFIRM_PREFIX}${landlordId}`, displayText: 'ใช่ ยืนยัน' },
      },
      {
        type: 'action',
        action: { type: 'postback', label: '❌ ไม่ใช่', data: LINK_CANCEL, displayText: 'ไม่ใช่' },
      },
    ];
    return replyMessages(replyToken, [
      {
        type: 'text',
        text: `ยืนยันผูกบัญชี LINE นี้กับ «${name}» ใช่ไหมครับ?\n(ผูกแล้วจะเห็นข้อมูลห้องและรายรับ-รายจ่ายของ ${name})`,
        quickReply: { items },
      },
    ]);
  }

  if (data.startsWith(LINK_CONFIRM_PREFIX)) {
    const landlordId = data.slice(LINK_CONFIRM_PREFIX.length);
    const linked = await linkLandlordToLineUser(landlordId, userId);
    if (!linked) {
      // Claimed by someone else between confirm taps — offer what's left.
      await replyText(replyToken, 'ชื่อนี้เพิ่งถูกผูกกับบัญชีอื่นไปครับ');
      return;
    }
    console.log(`[link] ${userId} → landlord ${linked.id} (${linked.display_name})`);
    return replyText(
      replyToken,
      `✓ ผูกบัญชีสำเร็จ — สวัสดีครับคุณ${linked.display_name} 🎉\n` +
        'พิมพ์ /help เพื่อดูคำสั่งทั้งหมด หรือ /dashboard เพื่อเปิดแดชบอร์ดครับ',
    );
  }

  if (data === LINK_CANCEL) {
    const offered = await offerLinkPicker(replyToken);
    if (!offered) await replyText(replyToken, 'ไม่มีรายชื่อให้เลือกแล้วครับ');
    return;
  }

  if (data === LINK_NEW) {
    const name = await getUserName(userId);
    const landlord = await upsertLandlord(userId, name);
    console.log(`[link] new profile ${userId} → landlord ${landlord.id} (${landlord.display_name})`);
    return replyText(
      replyToken,
      `✓ สร้างโปรไฟล์ใหม่ให้แล้วครับ (${landlord.display_name ?? 'ไม่มีชื่อ'})\n` +
        'พิมพ์ /help เพื่อดูคำสั่งทั้งหมดครับ',
    );
  }
}
