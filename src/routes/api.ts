import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { verifyIdToken } from '../liff/verify';
import { getLandlordByLineUserId } from '../services/landlords';
import { createLease, listProperties } from '../services/leases';
import { getHomeOverview, getPropertyDetail } from '../services/views';

// Authenticate a LIFF request via `Authorization: Bearer <id_token>`.
// Throws AuthError (→ 401) on any problem, NeedsLinkError (→ 403) when the
// LINE account has no landlord row. LIFF never creates profiles: the LIFF URL
// is reachable by any LINE user once the Login channel is published, so every
// newcomer must go through the bot's invite-gated 1:1 chat (linkHandler),
// which links them to their family row or creates a fresh profile.
class AuthError extends Error {}
class NeedsLinkError extends Error {}

async function authLandlord(request: FastifyRequest): Promise<{ landlordId: string }> {
  const header = request.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new AuthError('ไม่พบ token สำหรับยืนยันตัวตน');
  }
  const idToken = header.slice('Bearer '.length).trim();
  let verified;
  try {
    verified = await verifyIdToken(idToken);
  } catch (err) {
    throw new AuthError(err instanceof Error ? err.message : 'ยืนยัน token ไม่สำเร็จ');
  }

  const existing = await getLandlordByLineUserId(verified.userId);
  if (existing) return { landlordId: existing.id };

  throw new NeedsLinkError(
    'ยังไม่ได้ผูกบัญชี LINE กับรายชื่อครอบครัว — ทักแชทส่วนตัวกับบอท แล้วแตะเลือกชื่อของคุณก่อนครับ',
  );
}

/** Shared auth wrapper: sends the right error response, or returns the landlord id. */
async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  try {
    const { landlordId } = await authLandlord(request);
    return landlordId;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ไม่ได้รับอนุญาต';
    await reply.code(err instanceof NeedsLinkError ? 403 : 401).send({ error: message });
    return null;
  }
}

const leaseBodySchema = z
  .object({
    propertyId: z.string().uuid().optional(),
    building: z.string().trim().min(1).max(120).optional(),
    unitNo: z.string().trim().min(1).max(40).optional(),
    tenantName: z.string().trim().min(1).max(120),
    rentAmount: z.number().positive(),
    billingType: z.enum(['fixed', 'rent_plus_utilities']),
    depositAmount: z.number().nonnegative().nullish(),
    dueDay: z.number().int().min(1).max(28),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'วันที่เริ่มต้องเป็นรูปแบบ YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'วันที่สิ้นสุดต้องเป็นรูปแบบ YYYY-MM-DD'),
    firstInvoiceOverride: z.number().positive().nullish(),
    expectedPayerName: z.string().trim().max(120).nullish(),
  })
  .refine((d) => d.propertyId !== undefined || (d.building !== undefined && d.unitNo !== undefined), {
    message: 'เลือกห้องที่มีอยู่ หรือระบุทั้งชื่ออาคารและเลขห้องครับ',
  })
  .refine((d) => d.endDate > d.startDate, { message: 'วันที่สิ้นสุดต้องอยู่หลังวันที่เริ่มครับ' });

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Public config for the LIFF frontend to initialise itself.
  app.get('/api/config', async (_req, reply: FastifyReply) => {
    if (!config.LIFF_ID) return reply.code(503).send({ error: 'ยังไม่ได้ตั้งค่า LIFF_ID' });
    return { liffId: config.LIFF_ID };
  });

  app.get('/api/properties', async (request, reply) => {
    const landlordId = await requireAuth(request, reply);
    if (!landlordId) return reply;
    return { properties: await listProperties(landlordId) };
  });

  // Dashboard main page: family pool balance + one card per condo.
  // Internal family app — any authenticated member sees the whole picture.
  app.get('/api/home', async (request, reply) => {
    if (!(await requireAuth(request, reply))) return reply;
    return getHomeOverview();
  });

  // Dashboard condo page: all-time net, this month's rent status,
  // 12-month net series, and the condo's full transaction list.
  app.get('/api/property/:id', async (request, reply) => {
    if (!(await requireAuth(request, reply))) return reply;

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'รหัสห้องไม่ถูกต้อง' });

    const detail = await getPropertyDetail(params.data.id);
    if (!detail) return reply.code(404).send({ error: 'ไม่พบห้องนี้ในระบบ' });
    return detail;
  });

  app.post('/api/leases', async (request, reply) => {
    const landlordId = await requireAuth(request, reply);
    if (!landlordId) return reply;

    const parsed = leaseBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    try {
      const result = await createLease({ landlordId, ...parsed.data });
      return reply.code(201).send(result);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'สร้างสัญญาเช่าไม่สำเร็จ' });
    }
  });
}
