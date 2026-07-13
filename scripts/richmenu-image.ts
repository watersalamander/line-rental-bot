/**
 * Render assets/richmenu.png (2500x1686) for the owner rich menu.
 *
 * Run locally (sharp is a devDependency; Thai text needs the local
 * Windows fonts, so this never runs in the Docker image):
 *   npx tsx scripts/richmenu-image.ts
 *
 * Commit the resulting PNG. scripts/setup-richmenu.ts uploads it.
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { RICH_MENU_IMAGE_PATH } from '../src/line/richmenu';

const W = 2500;
const H = 1686;
const CW = W / 2;
const CH = H / 2;

interface Cell {
  x: number;
  y: number;
  icon: string;
  label: string;
  bg: string;
}

// Icons are drawn as text glyphs; labels sit below. Colors: calm two-tone
// green/teal palette that reads well at chat-bar size.
const cells: Cell[] = [
  { x: 0, y: 0, icon: '📄', label: 'เพิ่มสัญญาเช่า', bg: '#0f766e' },
  { x: 1, y: 0, icon: '💰', label: 'บันทึกรายรับ-รายจ่าย', bg: '#115e59' },
  { x: 0, y: 1, icon: '📈', label: 'แดชบอร์ด', bg: '#115e59' },
  { x: 1, y: 1, icon: '🔔', label: 'แจ้งเตือนค่าเช่า', bg: '#0f766e' },
];

const cellSvg = (c: Cell) => `
  <g transform="translate(${c.x * CW}, ${c.y * CH})">
    <rect x="0" y="0" width="${CW}" height="${CH}" fill="${c.bg}"/>
    <text x="${CW / 2}" y="${CH / 2 - 60}" font-size="220" fill="#ffffff" text-anchor="middle">${c.icon}</text>
    <text x="${CW / 2}" y="${CH / 2 + 210}" font-size="110" font-weight="bold" fill="#ffffff"
          text-anchor="middle" font-family="Leelawadee UI, Tahoma, sans-serif">${c.label}</text>
  </g>`;

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  ${cells.map(cellSvg).join('\n')}
  <line x1="${CW}" y1="0" x2="${CW}" y2="${H}" stroke="#134e4a" stroke-width="6"/>
  <line x1="0" y1="${CH}" x2="${W}" y2="${CH}" stroke="#134e4a" stroke-width="6"/>
</svg>`;

async function main(): Promise<void> {
  const out = resolve(__dirname, '..', RICH_MENU_IMAGE_PATH);
  mkdirSync(dirname(out), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(out);

  const bytes = statSync(out).size;
  console.log(`wrote ${out} (${(bytes / 1024).toFixed(0)} KB)`);
  if (bytes >= 1024 * 1024) {
    throw new Error('rich menu image must be under 1 MB (LINE limit)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
