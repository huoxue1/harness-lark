/**
 * Per-turn sender context.
 *
 * The bridge records the Feishu message sender's open_id around the agent
 * turn so tools can resolve "who is talking" and, when that user has
 * authorized, call the Feishu API with the user's access token instead of
 * the app identity.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<string>()

/** Run `fn` with the given sender open_id in scope for the async chain. */
export function runWithSender<T>(senderOpenId: string, fn: () => T): T {
  return storage.run(senderOpenId, fn)
}

/** Read the current turn's sender open_id, or undefined outside a turn. */
export function currentSenderOpenId(): string | undefined {
  return storage.getStore()
}
