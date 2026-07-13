import type { messagingApi } from '@line/bot-sdk';

// ─────────────────────────────────────────────────────────────
// Owner rich menu — the 2x2 tap menu pinned in the 1:1 chat.
// Rich menus never render in group chats, so the tenant side is
// unaffected. Created once per channel by scripts/setup-richmenu.ts;
// the server itself never references the menu id.
//
// Cell layout (2500x1686, each cell 1250x843):
//   ┌──────────────────┬──────────────────────┐
//   │ เพิ่มสัญญาเช่า (LIFF) │ บันทึกรายรับ-รายจ่าย     │
//   ├──────────────────┼──────────────────────┤
//   │ แดชบอร์ด (LIFF)    │ แจ้งเตือนค่าเช่า          │
//   └──────────────────┴──────────────────────┘
// ─────────────────────────────────────────────────────────────

export const RICH_MENU_NAME = 'owner-menu-v1';
export const RICH_MENU_IMAGE_PATH = 'assets/richmenu.png';

export function ownerRichMenu(liffId: string): messagingApi.RichMenuRequest {
  return {
    size: { width: 2500, height: 1686 },
    selected: true, // menu open by default
    name: RICH_MENU_NAME,
    chatBarText: 'เมนู',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: 'เพิ่มสัญญาเช่า', uri: `https://liff.line.me/${liffId}/` },
      },
      {
        bounds: { x: 1250, y: 0, width: 1250, height: 843 },
        action: {
          type: 'postback',
          label: 'บันทึกรายรับ-รายจ่าย',
          data: 'menu:txn',
          displayText: 'บันทึกรายรับ-รายจ่าย',
        },
      },
      {
        bounds: { x: 0, y: 843, width: 1250, height: 843 },
        action: { type: 'uri', label: 'แดชบอร์ด', uri: `https://liff.line.me/${liffId}/dashboard/` },
      },
      {
        bounds: { x: 1250, y: 843, width: 1250, height: 843 },
        action: {
          type: 'postback',
          label: 'แจ้งเตือนค่าเช่า',
          data: 'menu:remind',
          displayText: 'แจ้งเตือนค่าเช่า',
        },
      },
    ],
  };
}
