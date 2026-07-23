import { randomInt } from 'node:crypto';
import { db } from '../db/client';
import type { InviteCode } from '../db/types';

// Unambiguous alphabet: no 0/O, 1/I/L — codes get read aloud or retyped by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
export const INVITE_EXPIRY_HOURS = 72;

/** Loose shape check before hitting the DB — real validation is the redeem query. */
export const INVITE_CODE_RE = /^[A-Z0-9]{6}$/;

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Mint a single-use invite code (admin-only at the call site). */
export async function createInviteCode(createdBy: string): Promise<InviteCode> {
  // PK collision on a 31^6 space is near-impossible; retry twice anyway.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await db
      .from('invite_codes')
      .insert({
        code: generateCode(),
        created_by: createdBy,
        expires_at: new Date(Date.now() + INVITE_EXPIRY_HOURS * 3_600_000).toISOString(),
      })
      .select()
      .single();
    if (!error) return data as InviteCode;
    if (error.code !== '23505') throw new Error(`createInviteCode: ${error.message}`);
  }
  throw new Error('createInviteCode: could not generate a unique code');
}

/**
 * Claim a code for a LINE account. Atomic: the used_by IS NULL guard means a
 * code redeems exactly once even under concurrent attempts. False = unknown,
 * expired, or already used.
 */
export async function redeemInviteCode(code: string, lineUserId: string): Promise<boolean> {
  const { data, error } = await db
    .from('invite_codes')
    .update({ used_by: lineUserId, used_at: new Date().toISOString() })
    .eq('code', code)
    .is('used_by', null)
    .gt('expires_at', new Date().toISOString())
    .select('code');
  if (error) throw new Error(`redeemInviteCode: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Permanent "was invited" check — the 1:1 gate for accounts with no landlord row yet. */
export async function hasRedeemedInvite(lineUserId: string): Promise<boolean> {
  const { data, error } = await db
    .from('invite_codes')
    .select('code')
    .eq('used_by', lineUserId)
    .limit(1);
  if (error) throw new Error(`hasRedeemedInvite: ${error.message}`);
  return (data ?? []).length > 0;
}
