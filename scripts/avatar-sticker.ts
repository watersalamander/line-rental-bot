/**
 * Crop panel 1 (the "rent received" card) out of the 3-panel avatar source and
 * write it as the slip-reply hero image.
 *
 *   npx tsx scripts/avatar-sticker.ts
 *
 * Tune the fractional bounds below against the logged source dimensions, then
 * copy the printed ratio into RECEIVED_IMAGE_RATIO in src/line/slipHandler.ts.
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const SRC = resolve(__dirname, '..', 'assets/avatar-source.png');
const OUT = resolve(__dirname, '..', 'public/stickers/rent-received.png');

// Panel-1 card bounds as fractions of the full image (left, top, right, bottom).
const BOUNDS = { left: 0.015, top: 0.13, right: 0.325, bottom: 0.8 };

async function main(): Promise<void> {
  const meta = await sharp(SRC).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  console.log(`source: ${W}x${H} ${meta.format}`);

  const left = Math.round(BOUNDS.left * W);
  const top = Math.round(BOUNDS.top * H);
  const width = Math.round(BOUNDS.right * W) - left;
  const height = Math.round(BOUNDS.bottom * H) - top;

  mkdirSync(dirname(OUT), { recursive: true });
  await sharp(SRC).extract({ left, top, width, height }).png().toFile(OUT);

  const bytes = statSync(OUT).size;
  const g = gcd(width, height);
  console.log(`cropped: ${width}x${height}  ratio ${width / g}:${height / g}  (${(bytes / 1024).toFixed(0)} KB)`);
  if (bytes >= 10 * 1024 * 1024) throw new Error('Flex image must be under 10 MB');
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
