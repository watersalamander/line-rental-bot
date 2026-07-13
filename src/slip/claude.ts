import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { normalizeModelIso, parseThaiSlipDate, stripInvisible } from './thaiDate';
import type { SlipData, SlipVerifier, VerifyOutcome } from './types';

// Structured-output schema the model must return. All fields required; unknown
// values come back as "" (or 0 / false) rather than null to keep the schema
// simple and strict-outputs-friendly.
const SLIP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'is_slip',
    'amount',
    'trans_ref',
    'trans_datetime_text',
    'trans_datetime',
    'sender_name',
    'sender_bank',
    'receiver_name',
    'receiver_bank',
  ],
  properties: {
    is_slip: { type: 'boolean', description: 'true only if this is a Thai bank / e-wallet transfer slip' },
    amount: { type: 'number', description: 'transfer amount in THB; 0 if unreadable' },
    trans_ref: { type: 'string', description: 'transaction reference / รหัสอ้างอิง exactly as printed; "" if none' },
    trans_datetime_text: {
      type: 'string',
      description:
        'the date and time EXACTLY as printed on the slip, character for character, no conversion ' +
        '(e.g. "21 มิ.ย. 69 07:20 น."); "" if not shown',
    },
    trans_datetime: {
      type: 'string',
      description:
        'ISO 8601 with +07:00 offset if date and time are shown; "" otherwise. Thai slips print ' +
        'Buddhist Era years (2569 or short "69" = 2026) — convert to Gregorian',
    },
    sender_name: { type: 'string', description: 'sender account holder name as printed; "" if none' },
    sender_bank: { type: 'string', description: 'sender bank name/short code; "" if none' },
    receiver_name: { type: 'string', description: 'receiver account holder name as printed; "" if none' },
    receiver_bank: { type: 'string', description: 'receiver bank name/short code; "" if none' },
  },
} as const;

interface SlipFields {
  is_slip: boolean;
  amount: number;
  trans_ref: string;
  trans_datetime_text: string;
  trans_datetime: string;
  sender_name: string;
  sender_bank: string;
  receiver_name: string;
  receiver_bank: string;
}

const PROMPT =
  'This image should be a Thai bank or e-wallet money-transfer slip. Read it and ' +
  'extract the fields defined by the schema. Read Thai text accurately. Use the ' +
  'exact transaction reference number printed on the slip. Copy the printed date/time ' +
  'into trans_datetime_text character for character WITHOUT converting anything — ' +
  'Thai month abbreviations look similar (มี.ค. / เม.ย. / มิ.ย.), so transcribe carefully. ' +
  'If the image is not a transfer slip, set is_slip=false and leave the other fields ' +
  'empty/0. Do not guess values.';

/**
 * Reads a payment slip with Claude Vision (default: claude-haiku-4-5).
 * NOTE: this extracts what is printed — it does NOT verify the transaction with
 * the bank, so it offers no protection against forged slips.
 */
export class ClaudeVisionVerifier implements SlipVerifier {
  async verify(
    image: Buffer,
    opts: { mimeType?: string; fileName?: string } = {},
  ): Promise<VerifyOutcome> {
    if (!config.ANTHROPIC_API_KEY) {
      return { ok: false, kind: 'error', message: 'ANTHROPIC_API_KEY not configured' };
    }

    const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const mediaType = (opts.mimeType ?? 'image/jpeg') as 'image/jpeg' | 'image/png';

    let fields: SlipFields;
    try {
      const response = await client.messages.create({
        model: config.ANTHROPIC_SLIP_MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
        // Structured outputs → guaranteed JSON matching SLIP_SCHEMA.
        output_config: { format: { type: 'json_schema', schema: SLIP_SCHEMA } },
      } as Anthropic.MessageCreateParamsNonStreaming);

      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      if (!textBlock) return { ok: false, kind: 'error', message: 'no text block in model response' };
      fields = JSON.parse(textBlock.text) as SlipFields;
    } catch (err) {
      return { ok: false, kind: 'error', message: `claude vision error: ${String(err)}` };
    }

    // Zero-width chars sneak into OCR'd refs and would defeat the dedupe index.
    const transRef = stripInvisible(fields.trans_ref).replace(/\s+/g, '');

    // Date: parse the verbatim printed text ourselves (models botch Buddhist-era
    // conversion and Thai month abbreviations); model ISO is only a fallback.
    const parsedDate = parseThaiSlipDate(fields.trans_datetime_text || '');
    const fallbackDate = normalizeModelIso(fields.trans_datetime || '');

    // Decide whether the image is even a payment slip before deciding it's an
    // unreadable one. A transaction ref is the strongest slip-specific signal
    // (random photos don't carry a รหัสอ้างอิง); an amount paired with a date is
    // the other giveaway. A lone number or lone date is NOT slip-like — those
    // show up on receipts, price tags, screenshots, etc.
    const hasRef = Boolean(transRef);
    const hasAmount = fields.amount > 0;
    const hasDate = Boolean(parsedDate || fallbackDate || fields.trans_datetime_text);
    const looksLikeSlip = fields.is_slip || hasRef || (hasAmount && hasDate);

    if (!looksLikeSlip) {
      // Random photo — stay silent so the bot isn't noisy in the group.
      return { ok: false, kind: 'not_a_slip', message: 'image is not a payment slip', raw: fields };
    }

    // It looks like a slip, but we can't reconcile without an amount and a
    // dedupe ref — surface it so the owner can check (the tenant may have paid).
    if (!hasAmount || !hasRef) {
      return { ok: false, kind: 'not_found', message: 'slip fields incomplete', raw: fields };
    }

    if (!parsedDate && fields.trans_datetime_text) {
      console.warn(`[slip] verbatim date unparsed: ${JSON.stringify(fields.trans_datetime_text)} — using model ISO`);
    }

    const slip: SlipData = {
      amount: Number(fields.amount),
      transRef,
      transDatetime: parsedDate ?? fallbackDate ?? '',
      senderName: fields.sender_name || null,
      senderBank: fields.sender_bank || null,
      receiverName: fields.receiver_name || null,
      receiverBank: fields.receiver_bank || null,
      raw: fields,
    };
    return { ok: true, slip };
  }
}
