/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for Feishu/Lark.
 *
 * Ported from openclaw-lark's device-flow.ts (MIT, ByteDance Ltd.). Two-step
 * flow: request a device_code + user_code, then poll the token endpoint until
 * the user authorises, rejects, or the code expires.
 */

import type { LarkBrand } from '../core/config-schema.ts'

export interface DeviceAuthResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export interface DeviceFlowTokenData {
  accessToken: string
  refreshToken: string
  expiresIn: number
  refreshExpiresIn: number
  scope: string
}

export type DeviceFlowResult =
  | { ok: true; token: DeviceFlowTokenData }
  | { ok: false; error: DeviceFlowError; message: string }

export type DeviceFlowError = 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token'

/** Resolve the OAuth endpoint URLs for a brand. */
export function resolveOAuthEndpoints(brand: LarkBrand): { deviceAuthorization: string; token: string } {
  if (brand === 'lark') {
    return {
      deviceAuthorization: 'https://accounts.larksuite.com/oauth/v1/device_authorization',
      token: 'https://open.larksuite.com/open-apis/authen/v2/oauth/token',
    }
  }
  return {
    deviceAuthorization: 'https://accounts.feishu.cn/oauth/v1/device_authorization',
    token: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  }
}

/** Request a device authorisation code. */
export async function requestDeviceAuthorization(params: {
  appId: string
  appSecret: string
  brand: LarkBrand
  scope?: string
}): Promise<DeviceAuthResponse> {
  const { appId, appSecret, brand } = params
  const endpoints = resolveOAuthEndpoints(brand)

  let scope = params.scope ?? ''
  if (!scope.includes('offline_access')) {
    scope = scope ? `${scope} offline_access` : 'offline_access'
  }

  const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString('base64')
  const body = new URLSearchParams()
  body.set('client_id', appId)
  body.set('scope', scope)

  const resp = await fetch(endpoints.deviceAuthorization, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  })

  const text = await resp.text()
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Device authorization failed: HTTP ${resp.status} – ${text.slice(0, 200)}`)
  }

  if (!resp.ok || data.error) {
    const msg = (data.error_description as string) ?? (data.error as string) ?? 'Unknown error'
    throw new Error(`Device authorization failed: ${msg}`)
  }

  return {
    deviceCode: data.device_code as string,
    userCode: data.user_code as string,
    verificationUri: data.verification_uri as string,
    verificationUriComplete: (data.verification_uri_complete as string) ?? (data.verification_uri as string),
    expiresIn: (data.expires_in as number) ?? 240,
    interval: (data.interval as number) ?? 5,
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

/** Poll the token endpoint until the user authorises or the code expires. */
export async function pollDeviceToken(params: {
  appId: string
  appSecret: string
  brand: LarkBrand
  deviceCode: string
  interval: number
  expiresIn: number
  signal?: AbortSignal
}): Promise<DeviceFlowResult> {
  const { appId, appSecret, brand, deviceCode, expiresIn, signal } = params
  const endpoints = resolveOAuthEndpoints(brand)
  const deadline = Date.now() + expiresIn * 1000
  let interval = params.interval
  let attempts = 0

  while (Date.now() < deadline && attempts < 200) {
    attempts++
    if (signal?.aborted) {
      return { ok: false, error: 'expired_token', message: 'Polling was cancelled' }
    }

    await sleep(interval * 1000, signal)

    let data: Record<string, unknown>
    try {
      const resp = await fetch(endpoints.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: appId,
          client_secret: appSecret,
        }).toString(),
      })
      data = (await resp.json()) as Record<string, unknown>
    } catch {
      interval = Math.min(interval + 1, 60)
      continue
    }

    const error = data.error as string | undefined

    if (!error && data.access_token) {
      return {
        ok: true,
        token: {
          accessToken: data.access_token as string,
          refreshToken: (data.refresh_token as string) ?? '',
          expiresIn: (data.expires_in as number) ?? 0,
          refreshExpiresIn: (data.refresh_expires_in as number) ?? 0,
          scope: (data.scope as string) ?? '',
        },
      }
    }

    switch (error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        interval = Math.min(interval + 5, 60)
        break
      case 'access_denied':
        return { ok: false, error: 'access_denied', message: 'User denied the authorization' }
      case 'expired_token':
        return { ok: false, error: 'expired_token', message: 'Device code expired' }
      default:
        return { ok: false, error: 'expired_token', message: data.error_description as string ?? 'Unknown error' }
    }
  }

  return { ok: false, error: 'expired_token', message: 'Device code expired' }
}
