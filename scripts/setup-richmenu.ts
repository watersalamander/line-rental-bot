/**
 * One-off rich menu setup — run locally against each channel:
 *   npx tsx scripts/setup-richmenu.ts                       # dev (.env.development / .env)
 *   NODE_ENV=production npx tsx scripts/setup-richmenu.ts   # prod channel
 *
 * Flags:
 *   --list        print the channel's rich menus and exit
 *   --delete-all  delete every rich menu on the channel and exit
 *
 * Idempotent: deletes any previous owner-menu-v* before creating the new
 * one, uploads assets/richmenu.png, and sets it as the channel default
 * (shown to every friend; postback handlers guard non-owners).
 *
 * Deploy the webhook code FIRST — a live menu whose menu:* postbacks the
 * server doesn't understand replies with the group-bind fallback message.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lineBlobClient, lineClient } from '../src/line/client';
import { config } from '../src/config';
import { ownerRichMenu, RICH_MENU_IMAGE_PATH, RICH_MENU_NAME } from '../src/line/richmenu';

async function main(): Promise<void> {
  const flag = process.argv[2];
  const { richmenus } = await lineClient.getRichMenuList();

  if (flag === '--list') {
    if (richmenus.length === 0) console.log('(no rich menus on this channel)');
    for (const m of richmenus) console.log(`${m.richMenuId}  ${m.name}  ${m.size.width}x${m.size.height}`);
    return;
  }

  if (flag === '--delete-all') {
    for (const m of richmenus) {
      await lineClient.deleteRichMenu(m.richMenuId);
      console.log(`deleted ${m.richMenuId} (${m.name})`);
    }
    return;
  }

  if (!config.LIFF_ID) {
    throw new Error('LIFF_ID is not set — the menu\'s contract/dashboard buttons need it.');
  }

  // Re-runs replace the previous owner menu instead of piling up copies.
  for (const m of richmenus.filter((m) => m.name.startsWith('owner-menu-v'))) {
    await lineClient.deleteRichMenu(m.richMenuId);
    console.log(`deleted old menu ${m.richMenuId} (${m.name})`);
  }

  const { richMenuId } = await lineClient.createRichMenu(ownerRichMenu(config.LIFF_ID));
  console.log(`created ${RICH_MENU_NAME}: ${richMenuId}`);

  const png = readFileSync(resolve(__dirname, '..', RICH_MENU_IMAGE_PATH));
  await lineBlobClient.setRichMenuImage(richMenuId, new Blob([png], { type: 'image/png' }));
  console.log('image uploaded');

  await lineClient.setDefaultRichMenu(richMenuId);
  console.log('set as channel default — done ✔');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
