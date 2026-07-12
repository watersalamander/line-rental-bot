import type { FastifyInstance, FastifyRequest } from 'fastify';
import { validateSignature, type WebhookRequestBody } from '@line/bot-sdk';
import { config } from '../config';
import { handleEvent } from '../line/handleEvent';
import { notifyError } from '../services/alerts';

// Fastify request augmented with the raw JSON string captured by the content-type parser.
type RawBodyRequest = FastifyRequest & { rawBody?: string };

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhook', async (request: RawBodyRequest, reply) => {
    const signature = request.headers['x-line-signature'];
    const rawBody = request.rawBody;

    if (typeof signature !== 'string' || rawBody === undefined) {
      // Not a real LINE request (or the raw body wasn't captured).
      return reply.code(401).send({ error: 'missing signature' });
    }

    if (!validateSignature(rawBody, config.LINE_CHANNEL_SECRET, signature)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const body = request.body as WebhookRequestBody;

    // Ack immediately — LINE expects a fast 200 and retries on timeout.
    // Process events out of band so slow handlers never delay the response.
    reply.code(200).send({ ok: true });

    for (const event of body.events ?? []) {
      handleEvent(event).catch((err) => {
        console.error('[webhook] handler error:', err);
        void notifyError('webhook', err);
      });
    }
  });
}
