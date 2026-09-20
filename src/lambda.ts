import { join } from 'node:path';
import awsLambdaFastify, { type PromiseHandler } from '@fastify/aws-lambda';
import type { Context } from 'aws-lambda';
import { buildApp } from './app';
import { runScheduledJobs } from './scheduler';

// ─────────────────────────────────────────────────────────────
// AWS Lambda entry point (production). One function, two callers:
//  - the Function URL → HTTP requests (LINE webhook, LIFF pages, /api)
//    are replayed into Fastify via @fastify/aws-lambda;
//  - EventBridge Scheduler → `{ "source": "line-rental-bot.cron" }`
//    (see template.yaml) runs whatever cron jobs are due.
// The build (scripts/build-lambda.ts) bundles this file to index.js
// with public/ copied next to it.
// ─────────────────────────────────────────────────────────────

const CRON_SOURCE = 'line-rental-bot.cron';

// Built once per container and reused across warm invocations.
let proxy: Promise<PromiseHandler> | undefined;

async function createProxy(): Promise<PromiseHandler> {
  const app = await buildApp({ publicDir: join(__dirname, 'public') });
  const handler = awsLambdaFastify(app, {
    // Flex hero images must go out base64-encoded or Lambda corrupts them.
    binaryMimeTypes: ['image/png', 'image/jpeg', 'image/x-icon'],
  });
  await app.ready();
  return handler;
}

export async function handler(event: unknown, context: Context): Promise<unknown> {
  if ((event as { source?: unknown } | null)?.source === CRON_SOURCE) {
    await runScheduledJobs();
    return { ok: true };
  }
  proxy ??= createProxy().catch((err) => {
    proxy = undefined; // don't cache a failed init for the container's lifetime
    throw err;
  });
  return (await proxy)(event, context);
}
