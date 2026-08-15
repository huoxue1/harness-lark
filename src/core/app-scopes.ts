/**
 * App-granted scope lookup and dynamic scope filtering for /feishu auth.
 *
 * Mirrors openclaw-lark's app-scope-checker.ts: before starting the device
 * flow, query the app's granted user scopes and request only the intersection
 * of (needed scopes) × (app-granted scopes), so the consent page never asks
 * the user to approve permissions the app itself has not enabled. Results are
 * cached for 30 seconds (matching openclaw).
 */

import type { LarkClient } from './lark-client.ts'
import { USER_SCOPES } from './tool-scopes.ts'

const CACHE_TTL_MS = 30_000
const cache = new Map<string, { scopes: string[]; fetchedAt: number }>()

/**
 * The app's granted user-level scopes, or `null` when the query failed
 * (callers degrade to requesting the full needed list).
 */
export async function getAppGrantedUserScopes(lark: LarkClient): Promise<string[] | null> {
  const appId = lark.account.appId
  const cached = cache.get(appId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.scopes
  try {
    const sdk = lark.client as unknown as {
      request: (req: {
        method: string
        url: string
        params?: Record<string, unknown>
      }) => Promise<{
        code?: number
        data?: { app?: { scopes?: Array<{ scope?: string; token_types?: string[] }> } }
      }>
    }
    const res = await sdk.request({
      method: 'GET',
      url: `/open-apis/application/v6/applications/${appId}`,
      params: { lang: 'zh_cn' },
    })
    const scopes = (res.data?.app?.scopes ?? [])
      .filter((s) => typeof s.scope === 'string' && s.scope.length > 0)
      .filter((s) => !s.token_types || s.token_types.includes('user'))
      .map((s) => s.scope!)
    cache.set(appId, { scopes, fetchedAt: Date.now() })
    return scopes
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[harness-lark] failed to fetch app scopes: ${message}`)
    return null
  }
}

/** Scopes present in both lists (requested ∩ granted). */
export function intersectScopes(requested: readonly string[], granted: readonly string[]): string[] {
  const grantedSet = new Set(granted)
  return requested.filter((s) => grantedSet.has(s))
}

/** Requested scopes absent from the granted list. */
export function missingScopes(requested: readonly string[], granted: readonly string[]): string[] {
  const grantedSet = new Set(granted)
  return requested.filter((s) => !grantedSet.has(s))
}

/** Result of computing the effective device-flow scope at runtime. */
export interface ResolvedRequestScope {
  /** Space-joined scopes to request (empty when the app granted none). */
  scope: string
  /** Needed scopes the app has not granted (filtered out of the request). */
  filteredOut: string[]
  /** Direct link to enable the filtered-out scopes in the developer console. */
  permissionUrl: string
}

/**
 * Compute the device-flow scope: the needed scopes the app has actually
 * granted. When the app-scope query fails, degrades to requesting the full
 * needed list so a transient lookup error never blocks authorization.
 */
export async function resolveRequestScope(lark: LarkClient): Promise<ResolvedRequestScope> {
  const domain = lark.account.brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  const appId = lark.account.appId
  const granted = await getAppGrantedUserScopes(lark)
  if (granted === null) {
    return { scope: USER_SCOPES.join(' '), filteredOut: [], permissionUrl: `${domain}/app/${appId}/auth` }
  }
  const available = intersectScopes(USER_SCOPES, granted)
  const filteredOut = missingScopes(USER_SCOPES, granted)
  const permissionUrl = `${domain}/app/${appId}/auth?q=${encodeURIComponent(filteredOut.join(','))}`
  return { scope: available.join(' '), filteredOut, permissionUrl }
}
