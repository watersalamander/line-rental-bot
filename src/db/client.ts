import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

// Server-side client using the service_role key: full DB access, bypasses RLS.
// This key must never reach the browser/LIFF — those get the anon key instead.
export const db = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
