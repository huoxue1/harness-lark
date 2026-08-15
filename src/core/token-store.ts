/**
 * User access token (UAT) store for harness-lark OAuth.
 *
 * The live store is an in-memory Map so the hot tool path reads synchronously.
 * Durability comes from a persistence sink the plugin wires to dsh's built-in
 * `ctx.settings` store (a namespace in `~/.dsh/settings.yaml`, inside the
 * persisted data volume): every mutation snapshots the map and persists it
 * fire-and-forget, and the plugin hydrates the map from the store at startup,
 * so tokens survive process restarts and the user authorizes once. Token
 * values never reach tool results or the model.
 */

export interface StoredTokenRecord {
  accessToken: string
  refreshToken: string
  /** Unix ms — access_token expiry. */
  expiresAt: number
  /** Unix ms — refresh_token expiry. */
  refreshExpiresAt: number
  scope: string
}

/** One persisted entry: the user open_id plus its token record. */
export interface TokenEntry {
  openId: string
  token: StoredTokenRecord
}

const store = new Map<string, StoredTokenRecord>()

/** Durable persistence sink; absent until the plugin wires it to ctx.settings. */
let persistAll: ((entries: TokenEntry[]) => Promise<void>) | undefined

/** Install the durable persistence sink (called by the plugin entry). */
export function initTokenPersistence(persist: (entries: TokenEntry[]) => Promise<void>): void {
  persistAll = persist
}

/** Replace the in-memory store with records loaded from durable storage. */
export function hydrateTokens(entries: TokenEntry[]): void {
  store.clear()
  for (const { openId, token } of entries) store.set(openId, token)
}

/** Snapshot the map into the durable sink after every mutation. */
function schedulePersist(): void {
  if (!persistAll) return
  const snapshot: TokenEntry[] = []
  for (const [openId, token] of store) snapshot.push({ openId, token })
  void persistAll(snapshot).catch((error: unknown) => {
    console.warn(`[harness-lark] failed to persist user tokens: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/** Save a token for a user open_id. */
export function setStoredToken(
  openId: string,
  token: {
    accessToken: string
    refreshToken: string
    expiresIn: number
    refreshExpiresIn?: number
    scope: string
  },
): void {
  const now = Date.now()
  store.set(openId, {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: now + token.expiresIn * 1000,
    refreshExpiresAt: token.refreshExpiresIn ? now + token.refreshExpiresIn * 1000 : now + 30 * 24 * 60 * 60 * 1000,
    scope: token.scope,
  })
  schedulePersist()
}

/** Whether the user has a stored, unexpired token. */
export function hasStoredToken(openId: string): boolean {
  const t = store.get(openId)
  return t !== undefined && t.expiresAt > Date.now()
}

/** Get the user's stored access token, or undefined. */
export function getStoredToken(openId: string): string | undefined {
  const t = store.get(openId)
  if (!t || t.expiresAt <= Date.now()) return undefined
  return t.accessToken
}

/** Remove the user's stored token. */
export function revokeStoredToken(openId: string): void {
  store.delete(openId)
  schedulePersist()
}

/** Status summary for the oauth tool (never includes token values). */
export function tokenStatus(openId: string): { authorized: boolean; expiresAt?: number; scope?: string } {
  const t = store.get(openId)
  if (!t || t.expiresAt <= Date.now()) return { authorized: false }
  return { authorized: true, expiresAt: t.expiresAt, scope: t.scope }
}

/** Read the raw stored token (for refresh); internal only. */
export function getStoredTokenRecord(openId: string): StoredTokenRecord | undefined {
  return store.get(openId)
}

/** Replace a user's stored token after a refresh. */
export function updateStoredToken(openId: string, token: StoredTokenRecord): void {
  store.set(openId, token)
  schedulePersist()
}
