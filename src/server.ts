import { join } from 'node:path';
import { config } from './config';
import { buildApp } from './app';
import { startScheduler } from './scheduler';

// Long-lived server entry point (local dev, Docker). Production runs on AWS
// Lambda via lambda.ts instead.
async function main(): Promise<void> {
  const app = await buildApp({ publicDir: join(__dirname, '..', 'public') });

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
