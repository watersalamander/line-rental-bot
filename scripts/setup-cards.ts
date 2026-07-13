/**
 * Crop the two cards out of the 2-panel avatar source (assets/avatar-source2.png)
 * and write them as Flex hero images:
 *   • left card  ("อย่าลืมชำระค่าเช่านะครับ") → public/stickers/rent-reminder.png
 *   • right card ("เชื่อมต่อเรียบร้อยครับ")   → public/stickers/setup-connected.png
 *
 *   npx tsx scripts/setup-cards.ts   (or: npm run cards:image)
 *
 * Tune the fractional bounds below against the logged source dimensions, then
 * copy each printed ratio into REMINDER_IMAGE_RATIO (reminders.ts) and
 * CONNECTED_IMAGE_RATIO (commands.ts) if you re-crop.
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const SRC = resolve(__dirname, '..', 'assets/avatar-source2.png');

// Full-card bounds as fractions of the source (left, top, right, bottom).
const CARDS = [
  { out: 'public/stickers/rent-reminder.png', bounds: { left: 0.015, top: 0.085, right: 0.485, bottom: 0.895 } },
  { out: 'public/stickers/setup-connected.png', bounds: { left: 0.515, top: 0.085, right: 0.985, bottom: 0.895 } },
];

async function main(): Promise<void> {
  const meta = await sharp(SRC).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  console.log(`source: ${W}x${H} ${meta.format}`);

  for (const card of CARDS) {
    const left = Math.round(card.bounds.left * W);
    const top = Math.round(card.bounds.top * H);
    const width = Math.round(card.bounds.right * W) - left;
    const height = Math.round(card.bounds.bottom * H) - top;

    const outPath = resolve(__dirname, '..', card.out);
    mkdirSync(dirname(outPath), { recursive: true });
    await sharp(SRC).extract({ left, top, width, height }).png().toFile(outPath);

    const bytes = statSync(outPath).size;
    const g = gcd(width, height);
    console.log(
      `${card.out}: ${width}x${height}  ratio ${width / g}:${height / g}  (${(bytes / 1024).toFixed(0)} KB)`,
    );
    if (bytes >= 10 * 1024 * 1024) throw new Error('Flex image must be under 10 MB');
  }
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
