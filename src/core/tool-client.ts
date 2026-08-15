/**
 * Tool client for harness-lark — unified user/tenant identity for SDK calls.
 *
 * Mirrors openclaw-lark's tool-client.ts (simplified): `invoke` runs an SDK
 * call with the authorizing user's access token when available, falling back
 * to the app identity. Uses the SDK's `Lark.withUserAccessToken()` to inject
 * the user token into ordinary SDK method calls.
 */

import * as Lark from '@larksuiteoapi/node-sdk'
import type { LarkClient } from './lark-client.ts'
import { currentSenderOpenId } from './sender-context.ts'
import { NeedAuthorizationError, getValidAccessToken } from './uat-client.ts'

/** A callback that runs one SDK method, receiving the per-request UAT options. */
export type InvokeFn<T> = (
  sdk: Lark.Client,
  opts?: ReturnType<typeof Lark.withUserAccessToken>,
) => Promise<T>

/**
 * A callback that runs one SDK method through the loosely-typed `api` handle.
 * The Lark SDK's request/response types are incomplete and version-drifted, so
 * callers that use `LarkClient.api` keep working through this relaxed surface.
 */
export type ApiFn<T> = (
  api: any,
  opts?: ReturnType<typeof Lark.withUserAccessToken>,
) => Promise<T>

/** A raw Feishu API request that the SDK does not cover with a typed method. */
export interface RawRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** API path starting with `/open-apis/`, e.g. `/open-apis/sheets/v2/...`. */
  url: string
  /** Request body. */
  data?: unknown
  /** Query-string params. */
  params?: Record<string, string | number | boolean | undefined>
}

export class ToolClient {
  constructor(
    private readonly lark: LarkClient,
  ) {}

  /** The current turn's sender open_id, or undefined outside a message turn. */
  get senderOpenId(): string | undefined {
    return currentSenderOpenId()
  }

  /** The SDK client (app identity). */
  get sdk(): Lark.Client {
    return this.lark.client
  }

  /**
   * Resolve the current sender's access token, refreshing it when expired.
   * Returns undefined when there is no token (or refresh failed), so callers
   * fall back to the app identity — matching the pre-refresh behavior.
   */
  private async resolveToken(): Promise<string | undefined> {
    const sender = this.senderOpenId
    if (!sender) return undefined
    try {
      return await getValidAccessToken({
        userOpenId: sender,
        appId: this.lark.account.appId,
        appSecret: this.lark.account.appSecret,
        brand: this.lark.account.brand,
      })
    } catch (error) {
      if (!(error instanceof NeedAuthorizationError)) {
        console.warn(`[harness-lark] token resolution failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return undefined
    }
  }

  /**
   * Execute an SDK call with the user's identity when the current sender has
   * authorized, else with the app identity.
   *
   * @param fn - the SDK call. When a user token is available, `opts` carries
   *   `withUserAccessToken(token)` and must be passed to the SDK method as its
   *   second argument.
   */
  async invoke<T>(fn: InvokeFn<T>): Promise<T> {
    const token = await this.resolveToken()
    if (token) {
      const opts = Lark.withUserAccessToken(token)
      try {
        return await fn(this.sdk, opts)
      } catch (err) {
        // Fall through to app identity on user-scoped failure, so a revoked or
        // insufficient-scope user token does not hard-break the tool.
        console.warn(`[harness-lark] user-scoped call failed, falling back to app identity: ${String(err)}`)
      }
    }
    return fn(this.sdk)
  }

  /**
   * Execute an SDK call through the loosely-typed `api` handle with the user's
   * identity when the current sender has authorized, else the app identity.
   * Mirrors `invoke`, but the callback receives `LarkClient.api` (the SDK
   * client as `any`) instead of the typed `Lark.Client`.
   */
  async invokeApi<T>(fn: ApiFn<T>): Promise<T> {
    return this.invoke(async (sdk, opts) => fn(sdk as any, opts))
  }

  /**
   * Execute a raw Feishu API request with the user's identity when the current
   * sender has authorized, else the app identity. Resolves to the Feishu
   * response envelope `{ code, msg, data }` (the SDK's response interceptor
   * unwraps the HTTP body). Use for endpoints the SDK does not type, e.g. the
   * sheets v2 values API.
   */
  async invokeRaw<T>(req: RawRequest): Promise<T> {
    const token = await this.resolveToken()
    if (token) {
      try {
        return await this.rawRequest<T>(req, Lark.withUserAccessToken(token))
      } catch (err) {
        // Fall through to app identity on user-scoped failure, matching invoke.
        console.warn(`[harness-lark] user-scoped raw call failed, falling back to app identity: ${String(err)}`)
      }
    }
    return this.rawRequest<T>(req)
  }

  private async rawRequest<T>(
    req: RawRequest,
    opts?: ReturnType<typeof Lark.withUserAccessToken>,
  ): Promise<T> {
    const sdk = this.sdk as unknown as {
      request: (
        payload: Record<string, unknown>,
        options?: ReturnType<typeof Lark.withUserAccessToken>,
      ) => Promise<T>
    }
    return sdk.request({
      method: req.method,
      url: req.url,
      data: req.data,
      params: req.params,
    }, opts)
  }
}

/** Create a ToolClient bound to a LarkClient. */
export function createToolClient(lark: LarkClient): ToolClient {
  return new ToolClient(lark)
}
