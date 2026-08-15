/**
 * Reaction management for harness-lark: add/remove emoji reactions on
 * Feishu messages. Ported from openclaw-lark's reactions.ts (MIT).
 */

import type * as Lark from '@larksuiteoapi/node-sdk'

/** Add a reaction to a message; returns the reaction id. */
export async function addReaction(
  client: Lark.Client,
  messageId: string,
  emojiType: string,
): Promise<{ reactionId: string }> {
  const response = await client.im.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: emojiType } } as never,
  })
  const reactionId = (response.data as { reaction_id?: string } | undefined)?.reaction_id
  if (!reactionId) {
    throw new Error(`[harness-lark] addReaction "${emojiType}" to ${messageId}: no reaction_id returned`)
  }
  return { reactionId }
}

/** Remove a reaction by its reaction id. */
export async function removeReaction(
  client: Lark.Client,
  messageId: string,
  reactionId: string,
): Promise<void> {
  await client.im.messageReaction.delete({
    path: { message_id: messageId, reaction_id: reactionId },
  })
}

/** Remove every reaction of the given emoji type the bot added to a message. */
export async function removeReactionByEmoji(
  client: Lark.Client,
  messageId: string,
  emojiType: string,
): Promise<void> {
  const response = await client.im.messageReaction.list({
    path: { message_id: messageId },
    params: { page_size: 50 } as never,
  })
  const items = (response.data as
    | { items?: Array<{ reaction_id?: string; reaction_type?: { emoji_type?: string }; operator_type?: string }> }
    | undefined)?.items ?? []
  for (const item of items) {
    if (item.reaction_type?.emoji_type === emojiType && item.reaction_id) {
      await removeReaction(client, messageId, item.reaction_id)
    }
  }
}
