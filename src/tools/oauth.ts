/**
 * Feishu user OAuth tool: authorize, status, revoke.
 *
 * The authorize action runs the device flow and returns the verification
 * URL and user code for the user to complete; token values never appear in
 * tool results. Ported from openclaw-lark's oauth.ts (MIT, ByteDance Ltd.).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LarkClient } from '../core/lark-client.ts'
import { resolveRequestScope } from '../core/app-scopes.ts'
import { requestDeviceAuthorization } from '../core/device-flow.ts'
import { revokeStoredToken, setStoredToken, tokenStatus } from '../core/token-store.ts'
import { registerLarkTool } from './register.ts'

/** Poll the token endpoint until the device flow completes. */
async function pollForToken(
  client: LarkClient,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const { pollDeviceToken } = await import('../core/device-flow.ts')
  const result = await pollDeviceToken({
    appId: client.account.appId,
    appSecret: client.account.appSecret,
    brand: client.account.brand,
    deviceCode,
    interval,
    expiresIn,
  })
  if (!result.ok) throw new Error(`oauth failed: ${result.message}`)
  return {
    accessToken: result.token.accessToken,
    refreshToken: result.token.refreshToken,
    expiresIn: result.token.expiresIn,
    scope: result.token.scope,
  }
}

export function registerOAuthTool(ctx: Context, resolveClient: () => LarkClient): void {
  registerLarkTool(ctx, {
    name: 'feishu_oauth',
    description:
      'Manage user OAuth authorization for Feishu APIs. ' +
      'Actions: authorize (start the device authorization flow, returns a URL and code the user must open/enter), ' +
      'status (check whether the current user has a valid authorization), ' +
      'revoke (remove the current user stored authorization). Token values are never returned.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['authorize', 'status', 'revoke'],
        description: 'Operation to perform.',
      },
      open_id: { type: 'string', description: 'The user open_id to authorize (for authorize/status/revoke).' },
    },
    timeoutMs: 300_000,
    resolveClient,
    async execute(args, client, _exec, tc) {
      const action = String(args.action)
      // Default to the current message sender; the explicit open_id is for
      // checking/authorizing other users.
      const openId = args.open_id ? String(args.open_id) : (tc.senderOpenId ?? 'self')

      switch (action) {
        case 'authorize': {
          // Request only the scopes the app has actually granted (dynamic filter).
          const { scope, filteredOut, permissionUrl } = await resolveRequestScope(client)
          if (!scope.trim()) {
            return {
              error: 'app_scopes_not_granted',
              message: `应用未开通任何所需的用户权限，无法发起授权。请先在开放平台开通：${permissionUrl}`,
              unavailable_scopes: filteredOut,
              app_permission_url: permissionUrl,
            }
          }
          const auth = await requestDeviceAuthorization({
            appId: client.account.appId,
            appSecret: client.account.appSecret,
            brand: client.account.brand,
            scope,
          })
          // Store the flow handle for later token persistence; the actual
          // token arrives when the user completes the flow, which the plugin
          // polls in the background.
          void pollForToken(client, auth.deviceCode, auth.interval, auth.expiresIn)
            .then((token) => {
              setStoredToken(openId, token)
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error)
              console.warn(`[harness-lark] oauth poll failed: ${message}`)
            })
          return {
            verification_uri: auth.verificationUri,
            user_code: auth.userCode,
            expires_in: auth.expiresIn,
            instructions: `Open ${auth.verificationUri} and enter code ${auth.userCode} to authorize.`,
            ...(filteredOut.length > 0
              ? {
                  filtered_out_scopes: filteredOut,
                  note: `Skipped ${filteredOut.length} scope(s) the app has not granted; enable them at ${permissionUrl} and re-authorize to use those capabilities.`,
                }
              : {}),
          }
        }
        case 'status':
          return tokenStatus(openId)
        case 'revoke':
          revokeStoredToken(openId)
          return { revoked: true }
        default:
          throw new Error(`oauth: unknown action "${action}"`)
      }
    },
  })
}
