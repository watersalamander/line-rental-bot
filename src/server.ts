import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config';
import { webhookRoutes } from './routes/webhook';
import { apiRoutes } from './routes/api';
import { startScheduler } from './scheduler';

async function main(): Promise<void> {
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
    root: join(__dirname, '..', 'public'),
    prefix: '/',
  });

  await app.register(webhookRoutes);
  await app.register(apiRoutes);

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`LINE rental bot listening on :${config.PORT} (${config.NODE_ENV})`);
    await startScheduler(); // Phase 5 cron (no-op with a clear log if 0002 not applied)
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
