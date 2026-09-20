import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config';
import { webhookRoutes } from './routes/webhook';
import { apiRoutes } from './routes/api';

/**
 * Builds the Fastify app without binding a port, so the same routes run under
 * a long-lived server (server.ts) and AWS Lambda (lambda.ts).
 * `publicDir` = absolute path of the static LIFF assets (differs per entry
 * point because the Lambda bundle is a single file next to public/).
 */
export async function buildApp(opts: { publicDir: string }): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // LINE signature verification runs over the EXACT raw request bytes, so we
  // must retain the raw string while still parsing JSON for the handlers.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/health', async () => ({ status: 'ok', env: config.NODE_ENV }));

  // Serve the LIFF form and any static assets from public/ (e.g. /liff/).
  await app.register(fastifyStatic, {
    root: opts.publicDir,
    prefix: '/',
  });

  await app.register(webhookRoutes);
  await app.register(apiRoutes);

  return app;
}
