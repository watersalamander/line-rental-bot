import { db } from '../db/client';
import type { Landlord } from '../db/types';

/** Create the landlord on first contact, or return the existing row. */
export async function upsertLandlord(lineUserId: string, displayName: string | null): Promise<Landlord> {
  const row: { line_user_id: string; display_name?: string } = { line_user_id: lineUserId };
  if (displayName) row.display_name = displayName; // don't clobber an existing name with null

  const { data, error } = await db
    .from('landlords')
    .upsert(row, { onConflict: 'line_user_id' })
    .select()
    .single();

  if (error) throw new Error(`upsertLandlord: ${error.message}`);
  return data as Landlord;
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
