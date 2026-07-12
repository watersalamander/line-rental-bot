import type { MessageEvent, PostbackEvent, messagingApi } from '@line/bot-sdk';
import { getMessageContent, replyMessages, replyText } from './client';
import { getLandlordByLineUserId } from '../services/landlords';
import { listProperties } from '../services/leases';
import { getVerifier } from '../slip';
import { config } from '../config';
import {
  CATEGORY_TH,
  createExpense,
  DuplicateExpenseError,
  EXPENSE_CATEGORIES,
  inferCategory,
  setExpenseCategory,
  setExpenseProperty,
  type ExpenseCategory,
  type ExpenseRow,
} from '../services/expenses';
import type { Property } from '../db/types';

// Postback data formats (≤300 chars per LINE):
//   expp:<txnId>:<propertyId|none>:<catKnown 0|1>   — property picked
//   expc:<txnId>:<category>                          — category picked
export const EXP_PROP_PREFIX = 'expp:';
export const EXP_CAT_PREFIX = 'expc:';

export function isExpensePostback(data: string): boolean {
  return data.startsWith(EXP_PROP_PREFIX) || data.startsWith(EXP_CAT_PREFIX);
}

const baht = (n: number) => `฿${Number(n).toLocaleString('en-US')}`;

const quickLabel = (s: string) => (s.length > 20 ? `${s.slice(0, 19)}…` : s); // LINE cap

function propertyLabel(p: Property): string {
  return [p.building, p.unit_no].filter(Boolean).join(' ') || p.name || 'ห้อง';
}

// Typed expense: "<amount> [note]", e.g. "500 ค่าส่วนกลาง" / "1,250.50 ซ่อมแอร์".
// The note must be separated by whitespace so "2026-07" or "13.30น" never
// silently becomes an expense.
const TEXT_EXPENSE_RE = /^([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?:\s+(.*))?$/s;

/**
 * Non-command text in the owner's 1:1 chat. Records an expense when the
 * message starts with an amount; anything else is silently ignored so the
 * bot stays quiet during normal chat.
 */
export async function handleExpenseText(event: MessageEvent, text: string): Promise<void> {
  if (event.replyToken === undefined || event.source.type !== 'user') return;
  const match = TEXT_EXPENSE_RE.exec(text);
  if (!match) return;
  const amount = Number((match[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return;

  const landlord = await getLandlordByLineUserId(event.source.userId);
  if (!landlord) return; // unknown user typing numbers at the bot — stay quiet

  const note = (match[2] ?? '').trim();
  const category = inferCategory(note);
  const expense = await createExpense({
    landlordId: landlord.id,
    amount,
    txnDatetime: new Date().toISOString(),
    source: 'manual',
    category,
    raw: note ? { note } : null,
  });
  console.log(`[expense] manual ${amount} cat=${category ?? '?'} txn=${expense.id}`);

  await askProperty(event.replyToken, landlord.id, expense.id, amount, category !== null);
}

/** Image in the owner's 1:1 chat → read the slip → record the expense (spec §6). */
export async function handleExpenseImage(event: MessageEvent): Promise<void> {
  if (event.message.type !== 'image' || event.replyToken === undefined || event.source.type !== 'user') return;

  const landlord = await getLandlordByLineUserId(event.source.userId);
  if (!landlord) {
    return replyText(event.replyToken, 'ยังไม่พบข้อมูลของคุณ — เปิดแอปแล้วเพิ่มสัญญาเช่าก่อนครับ');
  }

  const image = await getMessageContent(event.message.id);
  console.log(`[expense] 1:1 image ${image.length} bytes, reading with ${config.SLIP_VENDOR}…`);
  const outcome = await getVerifier().verify(image, { fileName: `${event.message.id}.jpg` });

  if (!outcome.ok) {
    console.log(`[expense] verify FAILED kind=${outcome.kind} message=${outcome.message}`);
    return replyText(
      event.replyToken,
      'อ่านสลิปไม่สำเร็จครับ 🙏 พิมพ์จำนวนเงินแทนได้เลย เช่น "500 ค่าส่วนกลาง"',
    );
  }

  const amount = Number(outcome.slip.amount);
  try {
    const expense = await createExpense({
      landlordId: landlord.id,
      amount,
      txnDatetime: outcome.slip.transDatetime || new Date().toISOString(),
      source: 'slip',
      bankTxnRef: outcome.slip.transRef || null,
      raw: outcome.slip.raw,
    });
    console.log(`[expense] slip ${amount} ref=${outcome.slip.transRef} txn=${expense.id}`);
    await askProperty(event.replyToken, landlord.id, expense.id, amount, false);
  } catch (err) {
    if (err instanceof DuplicateExpenseError) {
      return replyText(event.replyToken, 'สลิปนี้เคยบันทึกไปแล้วครับ');
    }
    throw err;
  }
}

/** Step 1 buttons: which unit does this expense belong to (or the whole portfolio)? */
async function askProperty(
  replyToken: string,
  landlordId: string,
  txnId: string,
  amount: number,
  catKnown: boolean,
): Promise<void> {
  const flag = catKnown ? '1' : '0';
  const properties = (await listProperties(landlordId)).slice(0, 12); // 13-item quick-reply cap

  if (properties.length === 0) {
    // Nowhere to assign it — jump straight to the category question if needed.
    if (catKnown) return replyText(replyToken, `✓ บันทึกรายจ่าย ${baht(amount)} แล้วครับ`);
    return askCategory(replyToken, txnId, amount);
  }

  const items: messagingApi.QuickReplyItem[] = [
    ...properties.map((p): messagingApi.QuickReplyItem => ({
      type: 'action',
      action: {
        type: 'postback',
        label: quickLabel(propertyLabel(p)),
        data: `${EXP_PROP_PREFIX}${txnId}:${p.id}:${flag}`,
        displayText: propertyLabel(p),
      },
    })),
    {
      type: 'action',
      action: {
        type: 'postback',
        label: 'ทั่วไป (ไม่ระบุห้อง)',
        data: `${EXP_PROP_PREFIX}${txnId}:none:${flag}`,
        displayText: 'ทั่วไป',
      },
    },
  ];

  await replyMessages(replyToken, [
    { type: 'text', text: `บันทึกรายจ่าย ${baht(amount)} แล้ว — เป็นของห้องไหนครับ?`, quickReply: { items } },
  ]);
}

/** Step 2 buttons: expense category. */
async function askCategory(replyToken: string, txnId: string, amount: number): Promise<void> {
  const items: messagingApi.QuickReplyItem[] = EXPENSE_CATEGORIES.map((c) => ({
    type: 'action',
    action: {
      type: 'postback',
      label: CATEGORY_TH[c],
      data: `${EXP_CAT_PREFIX}${txnId}:${c}`,
      displayText: CATEGORY_TH[c],
    },
  }));
  await replyMessages(replyToken, [
    { type: 'text', text: `${baht(amount)} เป็นค่าอะไรครับ?`, quickReply: { items } },
  ]);
}

function confirmText(expense: ExpenseRow): string {
  const where = expense.property ? propertyLabel(expense.property) : 'ทั่วไป';
  const cat = CATEGORY_TH[expense.category as ExpenseCategory] ?? expense.category;
  return `✓ บันทึกรายจ่าย ${baht(expense.amount)} — ${where} · ${cat}`;
}

/** Postbacks from the two quick-reply steps above. */
export async function handleExpensePostback(event: PostbackEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (replyToken === undefined || event.source.type !== 'user') return;

  const landlord = await getLandlordByLineUserId(event.source.userId);
  if (!landlord) return;

  const data = event.postback.data;
  try {
    if (data.startsWith(EXP_PROP_PREFIX)) {
      const [txnId, propId, flag] = data.slice(EXP_PROP_PREFIX.length).split(':');
      if (!txnId || !propId) return;
      const expense = await setExpenseProperty(txnId, landlord.id, propId === 'none' ? null : propId);
      if (flag === '1') return replyText(replyToken, confirmText(expense));
      return askCategory(replyToken, txnId, expense.amount);
    }
    if (data.startsWith(EXP_CAT_PREFIX)) {
      const [txnId, category] = data.slice(EXP_CAT_PREFIX.length).split(':');
      if (!txnId || !category || !(EXPENSE_CATEGORIES as readonly string[]).includes(category)) return;
      const expense = await setExpenseCategory(txnId, landlord.id, category as ExpenseCategory);
      return replyText(replyToken, confirmText(expense));
    }
  } catch (err) {
    console.error('[expense] postback failed', err);
    return replyText(replyToken, err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้งครับ');
  }
}
