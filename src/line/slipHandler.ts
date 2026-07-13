import type { MessageEvent } from '@line/bot-sdk';
import { getMessageContent, pushText, replyText } from './client';
import { findActiveLeaseByGroup } from '../services/leases';
import { reconcileSlip, type ReconResult } from '../services/reconcile';
import { getVerifier } from '../slip';
import { config } from '../config';

const baht = (n: number) => `฿${Number(n).toLocaleString('en-US')}`;

/**
 * Slip reconciliation entry point (spec §5). Runs only for image messages in a
 * group that is bound to an active lease; other images are ignored here.
 */
export async function handleSlipImage(event: MessageEvent): Promise<void> {
  if (event.message.type !== 'image' || event.replyToken === undefined) return;
  if (event.source.type !== 'group') return; // 1:1 images route to expenseHandler in handleEvent

  const bound = await findActiveLeaseByGroup(event.source.groupId);
  if (!bound) {
    console.log(`[slip] image in unbound group ${event.source.groupId} — ignoring`);
    // Unbound group — stay quiet so the bot isn't noisy in random chats.
    return;
  }
  const { lease, property, landlord } = bound;
  console.log(`[slip] image in bound group → lease ${lease.id} (${property.building ?? ''} ${property.unit_no ?? ''})`);

  // Fetch the image bytes and verify against the bank.
  const image = await getMessageContent(event.message.id);
  console.log(`[slip] fetched ${image.length} bytes, reading with ${config.SLIP_VENDOR}…`);
  const outcome = await getVerifier().verify(image, { fileName: `${event.message.id}.jpg` });

  if (!outcome.ok) {
    console.log(`[slip] verify FAILED kind=${outcome.kind} message=${outcome.message}`);
    await handleVerifyFailure(event.replyToken, outcome.kind, landlord.line_user_id, property, lease);
    return;
  }
  console.log(
    `[slip] verify OK amount=${outcome.slip.amount} ref=${outcome.slip.transRef} ` +
      `sender=${outcome.slip.senderName ?? '∅'} date=${outcome.slip.transDatetime}`,
  );

  const result = await reconcileSlip({ landlordId: landlord.id, lease, property, slip: outcome.slip });
  console.log(`[slip] reconciled status=${result.status} late=${result.late} suspect=${result.suspect}`);
  await replyText(event.replyToken, groupReply(result));

  const alert = landlordAlert(result);
  if (alert && landlord.line_user_id) {
    await pushText(landlord.line_user_id, alert).catch((e) => console.error('[slip] push failed', e));
  }
}

async function handleVerifyFailure(
  replyToken: string,
  kind: 'duplicate' | 'not_found' | 'error',
  landlordUserId: string | null, // null = owner hasn't chatted with the bot yet — no DM possible
  property: { building: string | null; unit_no: string | null; name: string | null },
  lease: { tenant_name: string },
): Promise<void> {
  const unit = [property.building, property.unit_no].filter(Boolean).join(' ') || property.name || lease.tenant_name;

  if (kind === 'duplicate') {
    await replyText(replyToken, 'สลิปนี้เคยส่งมาแล้วนะครับ'); // "this slip was already submitted"
    if (landlordUserId) await pushText(landlordUserId, `⚠️ ${unit}: สลิปซ้ำถูกส่งเข้ามา`).catch(() => {});
    return;
  }
  // not_found / error → don't auto-confirm; flag the owner (spec §5.2).
  await replyText(replyToken, 'ยืนยันสลิปไม่สำเร็จ ผมแจ้งเจ้าของห้องให้ตรวจสอบแล้วนะครับ');
  if (landlordUserId) {
    await pushText(landlordUserId, `⚠️ ${unit}: ตรวจสอบสลิปไม่สำเร็จ มีสลิปที่ยืนยันไม่ได้ในกลุ่ม โปรดตรวจสอบ`).catch(() => {});
  }
}

/** In-group reply to the tenant (free reply message). */
function groupReply(r: ReconResult): string {
  const timing = r.late ? 'ล่าช้า' : 'ตรงเวลา';
  switch (r.status) {
    case 'paid':
      return `✓ ได้รับ ${baht(r.amount)} — ${r.unit} งวด ${r.period} (${timing})`;
    case 'partial':
      return `✓ ได้รับ ${baht(r.amount)} — ${r.unit} งวด ${r.period}\nยังค้างอีก ${baht(r.remaining ?? 0)}`;
    case 'overpaid':
      return `✓ ได้รับ ${baht(r.amount)} — ${r.unit} งวด ${r.period}\nเกินยอด ${baht(r.overpaidBy ?? 0)} แจ้งเจ้าของห้องแล้ว`;
    case 'no_open_invoice':
      return `✓ ได้รับ ${baht(r.amount)} — ${r.unit}\nยังไม่มีรอบบิลค้าง อาจเป็นการชำระล่วงหน้า แจ้งเจ้าของห้องแล้ว`;
    case 'duplicate':
      return 'สลิปนี้เคยส่งมาแล้วนะครับ';
    default:
      return `✓ ได้รับ ${baht(r.amount)} — ${r.unit}`;
  }
}

/** Private push to the landlord — only for cases that need a human's eyes. */
function landlordAlert(r: ReconResult): string | null {
  const parts: string[] = [];
  if (r.suspect) parts.push('ผู้โอนไม่ตรงกับที่คาดไว้');
  if (r.status === 'overpaid') parts.push(`ชำระเกิน ${baht(r.overpaidBy ?? 0)}`);
  if (r.status === 'no_open_invoice') parts.push('ไม่มีรอบบิลค้าง (อาจชำระล่วงหน้า)');
  if (r.status === 'duplicate') parts.push('สลิปซ้ำ');
  if (parts.length === 0) return null;
  return `⚠️ ${r.unit}: ${parts.join(' · ')} (${baht(r.amount)})`;
}
