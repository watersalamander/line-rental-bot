import type { messagingApi } from '@line/bot-sdk';

// ─────────────────────────────────────────────────────────────
// Owner rich menu — the tap menu pinned in the 1:1 chat.
// Rich menus never render in group chats, so the tenant side is
// unaffected. Created once per channel by scripts/setup-richmenu.ts;
// the server itself never references the menu id.
//
// Layout (2500x1686): a full-width banner on top, three cells below.
// Bounds match the dividers drawn in assets/richmenu.png.
//   ┌───────────────────────────────────────────────┐
//   │        บันทึกรายรับ-รายจ่าย  (full-width banner)     │  y 0..888
//   ├───────────────┬───────────────┬───────────────┤
//   │ เพิ่มสัญญาเช่า   │  แดชบอร์ด (LIFF) │ แจ้งเตือนค่าเช่า   │  y 888..1686
//   │    (LIFF)     │               │               │
//   └───────────────┴───────────────┴───────────────┘
//     x 0..833        x 833..1667      x 1667..2500
// ─────────────────────────────────────────────────────────────

export const RICH_MENU_NAME = 'owner-menu-v2';
export const RICH_MENU_IMAGE_PATH = 'assets/richmenu.png';

export function ownerRichMenu(liffId: string): messagingApi.RichMenuRequest {
  return {
    size: { width: 2500, height: 1686 },
    selected: true, // menu open by default
    name: RICH_MENU_NAME,
    chatBarText: 'เมนู',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 2500, height: 888 },
        action: {
          type: 'postback',
          label: 'บันทึกรายรับ-รายจ่าย',
          data: 'menu:txn',
          displayText: 'บันทึกรายรับ-รายจ่าย',
        },
      },
      {
        bounds: { x: 0, y: 888, width: 833, height: 798 },
        action: { type: 'uri', label: 'เพิ่มสัญญาเช่า', uri: `https://liff.line.me/${liffId}/` },
      },
      {
        bounds: { x: 833, y: 888, width: 834, height: 798 },
        action: { type: 'uri', label: 'แดชบอร์ด', uri: `https://liff.line.me/${liffId}/dashboard/` },
      },
      {
        bounds: { x: 1667, y: 888, width: 833, height: 798 },
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
