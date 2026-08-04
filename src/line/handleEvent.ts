import type { WebhookEvent } from '@line/bot-sdk';
import { handleCommand, handlePostback } from './commands';
import { handleSlipImage } from './slipHandler';
import { handleExpenseImage, handleExpensePostback, handleExpenseText, isExpensePostback } from './expenseHandler';
import { handleLinkPostback, interceptUnknownUser, isLinkPostback } from './linkHandler';
import { handleMenuPostback, isMenuPostback } from './menuHandler';
import { handleJoin, handleLeave } from './groupGate';
import { isAdminUser } from './admin';
import { findActiveLeaseByGroup } from '../services/leases';

/**
 * Top-level event dispatch.
 * Group chat = tenant side: slips reconcile against invoices (Phase 2).
 * 1:1 chat = owner side: commands, plus expense capture (Phase 4) from
 * images or amount-first text like "500 ค่าส่วนกลาง".
 */
export async function handleEvent(event: WebhookEvent): Promise<void> {
  const source = event.source;
  const scope =
    source.type === 'group' ? `group:${source.groupId}`
    : source.type === 'room' ? `room:${source.roomId}`
    : source.type === 'user' ? `user:${source.userId}`
    : 'unknown';
  console.log(`[event] ${event.type} from ${scope}`);

  // Layer 1: vet every group/room the bot gets invited into; alert the admin
  // when the bot is kicked out of a bound tenant group.
  if (event.type === 'join') return handleJoin(event);
  if (event.type === 'leave') return handleLeave(event);

  if (event.type === 'postback') {
    if (isLinkPostback(event.postback.data)) await handleLinkPostback(event);
    else if (isExpensePostback(event.postback.data)) await handleExpensePostback(event);
    else if (isMenuPostback(event.postback.data)) await handleMenuPostback(event);
    else await handlePostback(event);
    return;
  }

  if (event.type !== 'message' || event.replyToken === undefined) return;

  // Layer 1, message side: rooms are never serviced, and an unbound group gets
  // nothing except the admin's /setup — the one message that can register it.
  // (Backstop for groups joined while the server was down, where the join-event
  // gate never ran.)
  if (source.type === 'room') return;
  if (source.type === 'group') {
    const bound = await findActiveLeaseByGroup(source.groupId);
    if (!bound) {
      const text = event.message.type === 'text' ? event.message.text.trim() : '';
      if (/^\/setup\b/i.test(text) && isAdminUser(source.userId)) {
        return handleCommand(event, text);
      }
      console.log(`[gate] ignored ${event.message.type} in unbound ${scope}`);
      return;
    }
  }

  // 1:1 message from a LINE account with no landlord row → Layer-3 invite gate
  // (uninvited accounts must type a valid /invite code), then the identity
  // picker ("คุณคือใคร?") before any command/expense handling, so an unlinked
  // family member never gets a duplicate profile. Groups are tenant territory
  // and never see the picker.
  if (source.type === 'user' && (event.message.type === 'text' || event.message.type === 'image')) {
    if (await interceptUnknownUser(event)) return;
  }

  switch (event.message.type) {
    case 'text': {
      const text = event.message.text.trim();
      if (text.startsWith('/')) {
        await handleCommand(event, text);
      } else if (source.type === 'user') {
        // Owner 1:1: an amount-first message records an expense; other chatter is ignored.
        await handleExpenseText(event, text);
      }
      // Non-command chatter in a group is ignored (the bot shouldn't be noisy).
      break;
    }
    case 'image':
      if (source.type === 'user') await handleExpenseImage(event);
      else await handleSlipImage(event);
      break;
    default:
      break;
  }
}
