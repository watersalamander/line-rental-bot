import { config } from '../config';
import type { SlipData, SlipVerifier, VerifyOutcome } from './types';

const ENDPOINT = 'https://developer.easyslip.com/api/v1/verify';

// EasySlip error `message` codes that mean "this isn't a valid/verifiable slip"
// (as opposed to a transient/auth error we should surface differently).
const NOT_FOUND_CODES = new Set([
  'slip_not_found',
  'image_not_found',
  'invalid_payload',
  'qrcode_not_found',
  'unsupported_bank',
]);

interface EasySlipName {
  th?: string;
  en?: string;
}
interface EasySlipParty {
  bank?: { id?: string; name?: string; short?: string };
  account?: { name?: EasySlipName };
}
interface EasySlipData {
  transRef?: string;
  date?: string;
  amount?: { amount?: number } | number;
  sender?: EasySlipParty;
  receiver?: EasySlipParty;
}

function pickAmount(a: EasySlipData['amount']): number {
  if (typeof a === 'number') return a;
  return Number(a?.amount ?? 0);
}

function pickName(p?: EasySlipParty): string | null {
  return p?.account?.name?.th ?? p?.account?.name?.en ?? null;
}

function pickBank(p?: EasySlipParty): string | null {
  return p?.bank?.short ?? p?.bank?.name ?? null;
}

function normalize(data: EasySlipData, raw: unknown): SlipData {
  return {
    amount: pickAmount(data.amount),
    transRef: String(data.transRef ?? ''),
    transDatetime: String(data.date ?? ''),
    senderName: pickName(data.sender),
    senderBank: pickBank(data.sender),
    receiverName: pickName(data.receiver),
    receiverBank: pickBank(data.receiver),
    raw,
  };
}

export class EasySlipVerifier implements SlipVerifier {
  async verify(
    image: Buffer,
    opts: { mimeType?: string; fileName?: string } = {},
  ): Promise<VerifyOutcome> {
    if (!config.EASYSLIP_TOKEN) {
      return { ok: false, kind: 'error', message: 'EASYSLIP_TOKEN not configured' };
    }

    const form = new FormData();
    const blob = new Blob([image], { type: opts.mimeType ?? 'image/jpeg' });
    form.append('file', blob, opts.fileName ?? 'slip.jpg');
    // Dedupe is done against our own transactions table, so ask for full data.
    form.append('checkDuplicate', 'false');

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.EASYSLIP_TOKEN}` },
        body: form,
      });
    } catch (err) {
      return { ok: false, kind: 'error', message: `network error: ${String(err)}` };
    }

    type EasySlipResponse = { status?: number; message?: string; data?: EasySlipData };
    let json: EasySlipResponse | null = null;
    try {
      json = (await res.json()) as EasySlipResponse;
    } catch {
      json = null;
    }

    if (res.ok && json?.data) {
      return { ok: true, slip: normalize(json.data, json) };
    }

    const code = json?.message ?? `http_${res.status}`;
    if (code === 'duplicate_slip') return { ok: false, kind: 'duplicate', message: code, raw: json };
    if (NOT_FOUND_CODES.has(code)) return { ok: false, kind: 'not_found', message: code, raw: json };
    return { ok: false, kind: 'error', message: code, raw: json };
  }
}
