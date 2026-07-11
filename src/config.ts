import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// dev/prod isolation: load .env.${NODE_ENV} first, then a base .env fallback.
// Later calls do NOT override already-set vars, so the env-specific file wins.
const nodeEnv = process.env.NODE_ENV ?? 'development';
for (const file of [`.env.${nodeEnv}`, '.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) dotenv.config({ path });
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LINE_CHANNEL_SECRET: z.string().min(1, 'LINE_CHANNEL_SECRET is required'),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1, 'LINE_CHANNEL_ACCESS_TOKEN is required'),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

  // Phase 1 (LIFF). Optional so the server still boots before the LIFF app is
  // registered; the /api and /liff routes fail with a clear message if unset.
  LINE_LOGIN_CHANNEL_ID: z.string().optional(),
  LIFF_ID: z.string().optional(),

  // Phase 2 (slip reading). 'claude' = Claude Vision (default, pay-per-use, no
  // bank verification); 'easyslip' = EasySlip bank verification.
  SLIP_VENDOR: z.enum(['claude', 'easyslip']).default('claude'),
  EASYSLIP_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_SLIP_MODEL: z.string().default('claude-haiku-4-5'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Fail fast and loud — a half-configured webhook silently drops every event.
  throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
}

export const config = parsed.data;
export type Config = typeof config;
