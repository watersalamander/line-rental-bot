import { messagingApi } from '@line/bot-sdk';
import { config } from '../config';

const { MessagingApiClient, MessagingApiBlobClient } = messagingApi;

// Text/reply/push messages.
export const lineClient = new MessagingApiClient({
  channelAccessToken: config.LINE_CHANNEL_ACCESS_TOKEN,
});

// Binary content (image slips) — a separate client per the SDK's blob API.
export const lineBlobClient = new MessagingApiBlobClient({
  channelAccessToken: config.LINE_CHANNEL_ACCESS_TOKEN,
});

/** Reply is free and idempotent within the reply-token window — always prefer it over push. */
export async function replyText(replyToken: string, text: string): Promise<void> {
  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}

/** Reply with arbitrary message objects (e.g. text + quick-reply buttons). */
export async function replyMessages(
  replyToken: string,
  messages: messagingApi.Message[],
): Promise<void> {
  await lineClient.replyMessage({ replyToken, messages });
}

/** Push a private message to a user (metered — use sparingly, e.g. exception alerts). */
export async function pushText(userId: string, text: string): Promise<void> {
  await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
}

/** Push an arbitrary message object (e.g. a Flex card) to a user or group. */
export async function pushMessage(to: string, message: messagingApi.Message): Promise<void> {
  await lineClient.pushMessage({ to, messages: [message] });
}

/** Resolve a 1:1 user's LINE display name (requires the user to have added the bot). */
export async function getUserName(userId: string): Promise<string | null> {
  try {
    const profile = await lineClient.getProfile(userId);
    return profile.displayName ?? null;
  } catch {
    return null;
  }
}

/** Resolve a group member's display name (used later for sender ↔ payer matching). */
export async function getGroupMemberName(groupId: string, userId: string): Promise<string | null> {
  try {
    const profile = await lineClient.getGroupMemberProfile(groupId, userId);
    return profile.displayName ?? null;
  } catch {
    return null;
  }
}

/** True when the user is currently a member of the group (any member — no friendship needed). */
export async function isGroupMember(groupId: string, userId: string): Promise<boolean> {
  try {
    await lineClient.getGroupMemberProfile(groupId, userId);
    return true;
  } catch {
    return false;
  }
}

/** Leave a group (Layer-1 gate: the bot exits unregistered groups). */
export async function leaveGroup(groupId: string): Promise<void> {
  await lineClient.leaveGroup(groupId);
}

/** Leave a multi-person room — the bot never operates in rooms, only groups and 1:1. */
export async function leaveRoom(roomId: string): Promise<void> {
  await lineClient.leaveRoom(roomId);
}

/** Fetch the raw bytes of an image/file message for the slip-verification pipeline (Phase 2). */
export async function getMessageContent(messageId: string): Promise<Buffer> {
  const stream = await lineBlobClient.getMessageContent(messageId);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}
