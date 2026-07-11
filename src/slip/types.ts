// Vendor-neutral slip representation. Each adapter maps its raw API response
// into this shape so the reconciliation logic never depends on the vendor.
export interface SlipData {
  amount: number;
  transRef: string; // bank transaction reference — our dedupe key
  transDatetime: string; // ISO 8601 (vendor returns Thai local time)
  senderName: string | null;
  senderBank: string | null;
  receiverName: string | null;
  receiverBank: string | null;
  raw: unknown; // stored in transactions.raw_slip_json
}

export type VerifyOutcome =
  | { ok: true; slip: SlipData }
  | { ok: false; kind: 'duplicate' | 'not_found' | 'error'; message: string; raw?: unknown };

export interface SlipVerifier {
  verify(image: Buffer, opts?: { mimeType?: string; fileName?: string }): Promise<VerifyOutcome>;
}
