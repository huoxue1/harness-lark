/**
 * UAT (User Access Token) API wrapper for harness-lark.
 *
 * Executes Feishu API calls on behalf of an authorized user. Reads the stored
 * token, refreshes it when expired, and retries once on token-expiry errors.
 * The access token itself is never exposed to the model.
 */

import type { LarkBrand } from './config-schema.ts'
import { resolveOAuthEndpoints } from './device-flow.ts'
import {
  getStoredTokenRecord,
  updateStoredToken,
  revokeStoredToken,
} from './token-store.ts'

/** Error thrown when a user has no valid token — signals the model to re-auth. */
export class NeedAuthorizationError extends Error {
  constructor(public readonly userOpenId: string) {
    super(`User ${userOpenId} has no valid Feishu authorization; ask them to run /feishu auth`)
    this.name = 'NeedAuthorizationError'
  }
}

export interface UatOptions {
  userOpenId: string
  appId: string
  appSecret: string
  brand: LarkBrand
}

/** Refresh a user's access token via the OAuth token endpoint. */
async function refreshToken(opts: UatOptions, stored: NonNullable<ReturnType<typeof getStoredTokenRecord>>): Promise<string | null> {
  const now = Date.now()
  if (now >= stored.refreshExpiresAt || !stored.refreshToken) {
    revokeStoredToken(opts.userOpenId)
    return null
  }

  const endpoints = resolveOAuthEndpoints(opts.brand)
  const resp = await fetch(endpoints.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: opts.appId,
      client_secret: opts.appSecret,
    }).toString(),
  })

  if (!resp.ok) {
    revokeStoredToken(opts.userOpenId)
    return null
  }

  const data = (await resp.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    refresh_token_expires_in?: number
    scope?: string
  }

  if (!data.access_token) {
    revokeStoredToken(opts.userOpenId)
    return null
  }

  const updated = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? stored.refreshToken,
    expiresAt: now + (data.expires_in ?? 7200) * 1000,
    refreshExpiresAt: data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : stored.refreshExpiresAt,
    scope: data.scope ?? stored.scope,
  }
  updateStoredToken(opts.userOpenId, updated)
  return updated.accessToken
}

/** Obtain a valid access token, refreshing proactively when needed. */
export async function getValidAccessToken(opts: UatOptions): Promise<string> {
  const stored = getStoredTokenRecord(opts.userOpenId)
  if (!stored) throw new NeedAuthorizationError(opts.userOpenId)

  const now = Date.now()
  if (stored.expiresAt > now) return stored.accessToken

  const refreshed = await refreshToken(opts, stored)
  if (!refreshed) throw new NeedAuthorizationError(opts.userOpenId)
  return refreshed
}

/**
 * Execute a Feishu HTTP API call with the user's access token.
 * Retries once when the server reports an expired/invalid token.
 *
 * @param opts - user identity + app credentials.
 * @param path - the `/open-apis/...` path (no host).
 * @param init - fetch init (method, body, etc.); auth header is injected.
 */
export async function callWithUAT<T>(
  opts: UatOptions,
  path: string,
  init: { method?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const domain = opts.brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  const query = init.query
    ? '?' + new URLSearchParams(init.query).toString()
    : ''

  const call = async (token: string): Promise<T> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'
    const resp = await fetch(`${domain}${path}${query}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    const text = await resp.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    if (!resp.ok) {
      const err = data as { code?: number; msg?: string }
      const error = new Error(`Feishu API ${path} failed: HTTP ${resp.status} (${err.msg ?? text.slice(0, 200)})`)
      ;(error as Error & { code?: number }).code = err.code
      throw error
    }
    return data as T
  }

  const token = await getValidAccessToken(opts)
  try {
    return await call(token)
  } catch (err) {
    // Retry once on token-expiry codes.
    const code = (err as Error & { code?: number }).code
    if (code !== undefined && [99991663, 99991661, 99991668, 99991669].includes(code)) {
      const stored = getStoredTokenRecord(opts.userOpenId)
      if (stored) {
        const refreshed = await refreshToken(opts, stored)
        if (refreshed) return await call(refreshed)
      }
    }
    throw err
  }
}
