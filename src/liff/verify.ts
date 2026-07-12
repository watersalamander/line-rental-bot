import { config } from '../config';

interface LineVerifyResponse {
  sub: string; // the LINE user id
  name?: string;
  picture?: string;
  aud: string;
  exp: number;
}

/**
 * Verify a LIFF-issued ID token against LINE's endpoint. Returns the LINE user
 * id (and display name) only if the token is valid AND was issued for our own
 * Login channel — so a token from another app can't impersonate a landlord.
 */
export async function verifyIdToken(idToken: string): Promise<{ userId: string; name: string | null }> {
  if (!config.LINE_LOGIN_CHANNEL_ID) {
    throw new Error('ยังไม่ได้ตั้งค่า LINE_LOGIN_CHANNEL_ID — กรุณาลงทะเบียน LIFF/Login channel ก่อนครับ');
  }

  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: config.LINE_LOGIN_CHANNEL_ID }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`ยืนยัน LIFF token ไม่สำเร็จ (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as LineVerifyResponse;
  return { userId: data.sub, name: data.name ?? null };
}
