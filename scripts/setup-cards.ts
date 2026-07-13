/**
 * Crop the two cards out of the 2-panel avatar source (assets/avatar-source2.png)
 * and write them as Flex hero images:
 *   • left card  (megaphone / bell) → public/stickers/rent-reminder.png
 *   • right card (green checkmark)   → public/stickers/setup-connected.png
 *
 *   npx tsx scripts/setup-cards.ts   (or: npm run cards:image)
 *
 * We crop ONLY the illustration panel — inside its soft border, and excluding the
 * footer banner. The footer text ("เชื่อมต่อเรียบร้อยครับ" / "อย่าลืมชำระค่าเช่านะครับ")
 * is redundant with the Flex body copy, and cropping inside the panel avoids the
 * card frame's border showing up unevenly under aspectMode:'cover'. Tune the
 * fractional bounds below against the logged source dimensions, then copy each
 * printed ratio into REMINDER_IMAGE_RATIO (reminders.ts) and CONNECTED_IMAGE_RATIO
 * (commands.ts) if you re-crop.
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const SRC = resolve(__dirname, '..', 'assets/avatar-source2.png');

// Illustration-panel bounds as fractions of the source (left, top, right, bottom) —
// inset just inside each panel's border so no frame edge or footer text is captured.
const CARDS = [
  { out: 'public/stickers/rent-reminder.png', bounds: { left: 0.028, top: 0.108, right: 0.481, bottom: 0.678 } },
  { out: 'public/stickers/setup-connected.png', bounds: { left: 0.510, top: 0.108, right: 0.977, bottom: 0.675 } },
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
