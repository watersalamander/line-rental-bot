import { db } from '../db/client';
import type { Landlord } from '../db/types';

/**
 * Create the landlord on first contact, or return the existing row.
 * Select-then-insert rather than ON CONFLICT: since migration 0003 the
 * line_user_id unique guarantee is a PARTIAL index (WHERE not null), which
 * PostgREST's on_conflict cannot infer. The unique index still backstops the
 * rare concurrent double-insert (one of the two requests errors and retries).
 */
export async function upsertLandlord(lineUserId: string, displayName: string | null): Promise<Landlord> {
  const existing = await getLandlordByLineUserId(lineUserId);
  if (existing) return existing;

  const row: { line_user_id: string; display_name?: string } = { line_user_id: lineUserId };
  if (displayName) row.display_name = displayName;

  const { data, error } = await db.from('landlords').insert(row).select().single();
  if (error) throw new Error(`upsertLandlord: ${error.message}`);
  return data as Landlord;
}

/** Family members imported before ever chatting with the bot (line_user_id null). */
export async function listUnlinkedLandlords(): Promise<Landlord[]> {
  const { data, error } = await db
    .from('landlords')
    .select()
    .is('line_user_id', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listUnlinkedLandlords: ${error.message}`);
  return (data ?? []) as Landlord[];
}

/**
 * Bind a LINE account to an existing (unlinked) landlord row.
 * Atomic claim: the WHERE line_user_id IS NULL guard means a row can only be
 * linked once — returns null when someone else claimed it first.
 */
export async function linkLandlordToLineUser(landlordId: string, lineUserId: string): Promise<Landlord | null> {
  const { data, error } = await db
    .from('landlords')
    .update({ line_user_id: lineUserId })
    .eq('id', landlordId)
    .is('line_user_id', null)
    .select();
  if (error) throw new Error(`linkLandlordToLineUser: ${error.message}`);
  return ((data ?? [])[0] as Landlord | undefined) ?? null;
}

export async function getLandlordByLineUserId(lineUserId: string): Promise<Landlord | null> {
  const { data, error } = await db
    .from('landlords')
    .select()
    .eq('line_user_id', lineUserId)
    .maybeSingle();

  if (error) throw new Error(`getLandlordByLineUserId: ${error.message}`);
  return (data as Landlord | null) ?? null;
}
