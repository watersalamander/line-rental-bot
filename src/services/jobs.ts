import { db } from '../db/client';

/**
 * Claim an at-most-once key (see 0002_job_runs.sql). Returns true when this
 * caller won the claim and must perform the side effect; false when the key
 * was already claimed (someone already sent it). Claim BEFORE sending.
 */
export async function claimJobKey(jobKey: string): Promise<boolean> {
  const { error } = await db.from('job_runs').insert({ job_key: jobKey });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw new Error(`claimJobKey(${jobKey}): ${error.message}`);
}

/** True when the job_runs table exists (migration 0002 applied). */
export async function jobRunsTableExists(): Promise<boolean> {
  const { error } = await db.from('job_runs').select('job_key').limit(1);
  return !error;
}
