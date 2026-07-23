import type { JoinEvent } from '@line/bot-sdk';
import { isGroupMember, leaveGroup, leaveRoom, replyText } from './client';
import { findActiveLeaseByGroup } from '../services/leases';
import { propertyLabel } from '../services/labels';
import { config } from '../config';

// ─────────────────────────────────────────────────────────────
// Layer-1 gate: the bot is family-internal, but anyone on LINE
// can invite it into any group. So on every join we vet the room:
//   • group already bound to a lease  → stay (re-invite of a tenant group)
//   • unbound, but the ADMIN is a member → stay and prompt /setup —
//     this is the ONLY path to registering a new group
//   • anything else (stranger's group, multi-person room) → leave
// Messages from unbound groups are separately ignored in handleEvent,
// covering groups joined while the server was down.
// ─────────────────────────────────────────────────────────────

export async function handleJoin(event: JoinEvent): Promise<void> {
  const source = event.source;

  if (source.type === 'room') {
    console.log(`[gate] joined room ${source.roomId} — leaving (rooms unsupported)`);
    await leaveRoom(source.roomId);
    return;
  }
  if (source.type !== 'group') return;
  const groupId = source.groupId;

  const bound = await findActiveLeaseByGroup(groupId);
  if (bound) {
    console.log(`[gate] rejoined bound group ${groupId} (lease ${bound.lease.id})`);
    const unit = propertyLabel(bound.property) || bound.lease.tenant_name;
    await replyText(event.replyToken, `กลุ่มนี้เชื่อมกับ ${unit} อยู่แล้ว พร้อมใช้งานครับ ✅`);
    return;
  }

  const adminId = config.ADMIN_LINE_USER_ID;
  if (adminId && (await isGroupMember(groupId, adminId))) {
    console.log(`[gate] joined new group ${groupId} with admin present — awaiting /setup`);
    await replyText(
      event.replyToken,
      'สวัสดีครับ 🙏 กลุ่มนี้ยังไม่ได้เชื่อมกับห้อง\nแอดมินพิมพ์ /setup เพื่อเชื่อมกลุ่มนี้กับห้องได้เลยครับ',
    );
    return;
  }

  // Stranger's group (or admin not configured): announce and exit. The reply is
  // best-effort — the leave must happen even if it fails.
  console.log(`[gate] joined unregistered group ${groupId} without admin — leaving`);
  await replyText(event.replyToken, 'ขออภัยครับ บอทนี้ใช้งานภายในเท่านั้น ขอตัวออกจากกลุ่มนะครับ 🙏').catch(
    (e) => console.error('[gate] leave notice failed', e),
  );
  await leaveGroup(groupId);
}
