import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { verifyIdToken } from '../liff/verify';
import { upsertLandlord } from '../services/landlords';
import { createLease, listProperties } from '../services/leases';
import {
  currentPeriod,
  ensureInvoicesForPeriod,
  getCashflow,
  getUnitGrid,
  getUpcomingExpiries,
  isPeriod,
} from '../services/views';

// Authenticate a LIFF request via `Authorization: Bearer <id_token>`, upserting
// the landlord. Throws AuthError (→ 401) on any problem.
class AuthError extends Error {}

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
  const landlord = await upsertLandlord(verified.userId, verified.name);
  return { landlordId: landlord.id };
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
    let landlordId: string;
    try {
      ({ landlordId } = await authLandlord(request));
    } catch (err) {
      return reply.code(401).send({ error: err instanceof Error ? err.message : 'ไม่ได้รับอนุญาต' });
    }
    return { properties: await listProperties(landlordId) };
  });

  // Phase 3 — read-only dashboard payload: unit grid + cashflow + expiries.
  app.get('/api/dashboard', async (request, reply) => {
    let landlordId: string;
    try {
      ({ landlordId } = await authLandlord(request));
    } catch (err) {
      return reply.code(401).send({ error: err instanceof Error ? err.message : 'ไม่ได้รับอนุญาต' });
    }

    const q = request.query as { period?: string };
    const period = q.period && isPeriod(q.period) ? q.period : currentPeriod();

    await ensureInvoicesForPeriod(landlordId, period);
    const [grid, cashflow, expiries] = await Promise.all([
      getUnitGrid(landlordId, period),
      getCashflow(landlordId, period, 6),
      getUpcomingExpiries(landlordId, 90),
    ]);
    return { ...grid, cashflow, expiries, currentPeriod: currentPeriod() };
  });

  app.post('/api/leases', async (request, reply) => {
    let landlordId: string;
    try {
      ({ landlordId } = await authLandlord(request));
    } catch (err) {
      return reply.code(401).send({ error: err instanceof Error ? err.message : 'ไม่ได้รับอนุญาต' });
    }

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
