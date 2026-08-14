/**
 * In-memory user access token (UAT) store for harness-lark OAuth.
 *
 * openclaw-lark persists tokens to disk; harness-lark keeps them in memory
 * for the plugin lifetime. Token values never reach tool results.
 */

interface StoredToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
}

const store = new Map<string, StoredToken>()

/** Save a token for a user open_id. */
export function setStoredToken(
  openId: string,
  token: { accessToken: string; refreshToken: string; expiresIn: number; scope: string },
): void {
  store.set(openId, {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
    scope: token.scope,
  })
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
}

/** Status summary for the oauth tool (never includes token values). */
export function tokenStatus(openId: string): { authorized: boolean; expiresAt?: number; scope?: string } {
  const t = store.get(openId)
  if (!t || t.expiresAt <= Date.now()) return { authorized: false }
  return { authorized: true, expiresAt: t.expiresAt, scope: t.scope }
}
