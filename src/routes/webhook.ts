import type { FastifyInstance, FastifyRequest } from 'fastify';
import { validateSignature, type WebhookRequestBody } from '@line/bot-sdk';
import { config } from '../config';
import { handleEvent } from '../line/handleEvent';
import { notifyError } from '../services/alerts';

// Set by the Lambda runtime; absent on a long-lived server (local dev, Docker).
const IS_LAMBDA = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;

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

    const processEvents = (): Promise<unknown> =>
      Promise.all(
        (body.events ?? []).map((event) =>
          handleEvent(event).catch(async (err) => {
            console.error('[webhook] handler error:', err);
            await notifyError('webhook', err);
          }),
        ),
      );

    // Lambda freezes the container the moment the response is returned, so the
    // work has to finish BEFORE the ack. Safe while "Webhook redelivery" is off
    // in the LINE console (the default): LINE then never re-sends a slow event,
    // and reply tokens stay valid long enough for a slip read.
    if (IS_LAMBDA) {
      await processEvents();
      return reply.code(200).send({ ok: true });
    }

    // Long-lived server: ack immediately and process out of band so slow
    // handlers never delay the response.
    reply.code(200).send({ ok: true });
    void processEvents();
  });
}
