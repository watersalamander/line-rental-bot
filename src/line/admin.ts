import { config } from '../config';

/**
 * Layer-2 gate: ADMIN_LINE_USER_ID is the single admin account — the only one
 * allowed to register groups (/setup) and mint invite codes (/invite).
 * Unset admin → nobody passes (fail closed).
 */
export function isAdminUser(userId: string | undefined): boolean {
  return !!config.ADMIN_LINE_USER_ID && !!userId && userId === config.ADMIN_LINE_USER_ID;
}
