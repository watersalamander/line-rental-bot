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
// Divider geometry — must match the tap-area bounds in src/line/richmenu.ts:
// full-width banner on top, three equal cells below.
const BANNER_H = 888;
const COL = [0, 833, 1667, W]; // column edges for the bottom row

interface Cell {
  x0: number;
  x1: number;
  icon: string;
  label: string;
  bg: string;
}

// Icons are drawn as text glyphs; labels sit below. Colors: calm two-tone
// green/teal palette that reads well at chat-bar size.
const banner = { icon: '💰', label: 'บันทึกรายรับ-รายจ่าย', bg: '#0f766e' };
const cells: Cell[] = [
  { x0: COL[0], x1: COL[1], icon: '📄', label: 'เพิ่มสัญญาเช่า', bg: '#115e59' },
  { x0: COL[1], x1: COL[2], icon: '📈', label: 'แดชบอร์ด', bg: '#0f766e' },
  { x0: COL[2], x1: COL[3], icon: '🔔', label: 'แจ้งเตือนค่าเช่า', bg: '#115e59' },
];

const bannerSvg = `
  <g>
    <rect x="0" y="0" width="${W}" height="${BANNER_H}" fill="${banner.bg}"/>
    <text x="${W / 2}" y="${BANNER_H / 2 - 20}" font-size="220" fill="#ffffff" text-anchor="middle">${banner.icon}</text>
    <text x="${W / 2}" y="${BANNER_H / 2 + 190}" font-size="120" font-weight="bold" fill="#ffffff"
          text-anchor="middle" font-family="Leelawadee UI, Tahoma, sans-serif">${banner.label}</text>
  </g>`;

const cellSvg = (c: Cell) => {
  const cw = c.x1 - c.x0;
  const ch = H - BANNER_H;
  return `
  <g transform="translate(${c.x0}, ${BANNER_H})">
    <rect x="0" y="0" width="${cw}" height="${ch}" fill="${c.bg}"/>
    <text x="${cw / 2}" y="${ch / 2 - 40}" font-size="200" fill="#ffffff" text-anchor="middle">${c.icon}</text>
    <text x="${cw / 2}" y="${ch / 2 + 170}" font-size="90" font-weight="bold" fill="#ffffff"
          text-anchor="middle" font-family="Leelawadee UI, Tahoma, sans-serif">${c.label}</text>
  </g>`;
};

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  ${bannerSvg}
  ${cells.map(cellSvg).join('\n')}
  <line x1="0" y1="${BANNER_H}" x2="${W}" y2="${BANNER_H}" stroke="#134e4a" stroke-width="6"/>
  <line x1="${COL[1]}" y1="${BANNER_H}" x2="${COL[1]}" y2="${H}" stroke="#134e4a" stroke-width="6"/>
  <line x1="${COL[2]}" y1="${BANNER_H}" x2="${COL[2]}" y2="${H}" stroke="#134e4a" stroke-width="6"/>
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
