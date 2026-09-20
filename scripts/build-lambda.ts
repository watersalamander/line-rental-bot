import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

// ─────────────────────────────────────────────────────────────
// Builds the AWS Lambda artifact into lambda-dist/ (npm run build:lambda):
//   lambda-dist/index.js   — src/lambda.ts + all deps in one file
//   lambda-dist/public/    — static LIFF pages + Flex images
// template.yaml points CodeUri at this folder; `sam deploy` zips it.
// No node_modules ship: every runtime dependency is pure JS.
// ─────────────────────────────────────────────────────────────

const root = join(__dirname, '..');
const outDir = join(root, 'lambda-dist');

async function main(): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  await build({
    entryPoints: [join(root, 'src', 'lambda.ts')],
    outfile: join(outDir, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
    logLevel: 'info',
  });

  cpSync(join(root, 'public'), join(outDir, 'public'), { recursive: true });

  const kb = Math.round(statSync(join(outDir, 'index.js')).size / 1024);
  console.log(`lambda-dist ready — index.js ${kb} KB + public/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
