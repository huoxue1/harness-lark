/**
 * LarkClient — unified manager for the Feishu/Lark SDK client, WebSocket
 * long connection, and EventDispatcher lifecycle.
 *
 * Adapted from openclaw-lark's lark-client.ts to the harness-lark config
 * shape and single-account model.
 */

import * as Lark from '@larksuiteoapi/node-sdk'
import type { HarnessLarkConfig, LarkBrand } from './config-schema.ts'
import type { LarkAccount } from './types.ts'

/** Map a brand to the SDK domain. */
function resolveDomain(brand: LarkBrand): Lark.Domain {
  return brand === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu
}

/** Build an account record from plugin config. */
export function accountFromConfig(config: HarnessLarkConfig, accountId = 'default'): LarkAccount {
  return {
    accountId,
    appId: config.appId,
    appSecret: config.appSecret,
    encryptKey: config.encryptKey ?? '',
    verificationToken: config.verificationToken ?? '',
    brand: config.brand,
    config,
  }
}

export interface StartWsOptions {
  /** Event handlers keyed by event type, e.g. `im.message.receive_v1`. */
  handlers: Record<string, (data: unknown) => Promise<void> | void>
  /** Resolves when this signal fires. */
  abortSignal?: AbortSignal
  /** Probe bot identity before connecting. Default true. */
  autoProbe?: boolean
}

export class LarkClient {
  readonly account: LarkAccount
  private sdk: Lark.Client
  private wsClient: Lark.WSClient | null = null
  private botOpenIdInternal: string | undefined
  private botNameInternal: string | undefined

  constructor(account: LarkAccount) {
    this.account = account
    this.sdk = new Lark.Client({
      appId: account.appId,
      appSecret: account.appSecret,
      domain: resolveDomain(account.brand),
      loggerLevel: Lark.LoggerLevel.info,
    })
  }

  /** The bot's open_id, populated after a successful probe. */
  get botOpenId(): string | undefined {
    return this.botOpenIdInternal
  }

  /** The bot's display name, populated after a successful probe. */
  get botName(): string | undefined {
    return this.botNameInternal
  }

  get wsConnected(): boolean {
    return this.wsClient != null
  }

  /** Probe bot identity via the contact API. Safe to call repeatedly; caches result. */
  async probe(): Promise<void> {
    if (this.botOpenIdInternal) return
    try {
      const resp = await this.sdk.contact.user.get({
        params: { user_id_type: 'open_id' },
        path: { user_id: this.account.appId },
        data: {},
      })
      // The bot's own open_id is not directly queryable; derive from the
      // tenant-level contact endpoint instead. Fall back to app-scoped lookup.
      const data = (resp as { data?: { user?: { open_id?: string; name?: string } } }).data
      if (data?.user?.open_id) {
        this.botOpenIdInternal = data.user.open_id
        this.botNameInternal = data.user.name
      }
    } catch (error) {
      // Probe failure is non-fatal: the gateway still starts, and the
      // self-echo guard simply stays disabled.
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[harness-lark] bot probe failed: ${message}`)
    }
  }

  /**
   * Start the WebSocket event gateway.
   *
   * Flow: probe bot identity (optional) -> EventDispatcher -> WSClient -> start.
   * The returned promise resolves when `abortSignal` fires.
   */
  async startWS(opts: StartWsOptions): Promise<void> {
    const { handlers, abortSignal, autoProbe = true } = opts
    if (autoProbe) await this.probe()

    const dispatcher = new Lark.EventDispatcher({
      encryptKey: this.account.encryptKey,
      verificationToken: this.account.verificationToken,
    })
    dispatcher.register(handlers as never)

    // Close any previous WSClient before creating a new one.
    if (this.wsClient) {
      this.wsClient.close({ force: true })
      this.wsClient = null
    }

    this.wsClient = new Lark.WSClient({
      appId: this.account.appId,
      appSecret: this.account.appSecret,
      domain: resolveDomain(this.account.brand),
      loggerLevel: Lark.LoggerLevel.info,
    })

    // The SDK's handleEventData only routes type="event"; card action
    // callbacks arrive with type="card" and would be dropped. Patch the
    // header so EventDispatcher routes them like events.
    const wsAny = this.wsClient as unknown as {
      handleEventData: (data: {
        headers?: Array<{ key: string; value: string }>
        [key: string]: unknown
      }) => void
    }
    const original = wsAny.handleEventData.bind(wsAny)
    wsAny.handleEventData = (data) => {
      const typeHeader = data.headers?.find((h) => h.key === 'type')
      if (typeHeader?.value === 'card' && data.headers) {
        const patched = {
          ...data,
          headers: data.headers.map((h) =>
            h.key === 'type' ? { ...h, value: 'event' } : h,
          ),
        }
        original(patched)
        return
      }
      original(data)
    }

    // SDK >= 1.65 requires an explicit start() with the dispatcher; the
    // constructor no longer auto-connects. start() resolves after the
    // handshake settles, then this.waitForAbort holds until cancellation.
    await this.wsClient.start({ eventDispatcher: dispatcher } as never)

    await this.waitForAbort(dispatcher, abortSignal)
  }

  /** Disconnect the WebSocket but keep the HTTP client. */
  disconnect(): void {
    if (this.wsClient) {
      this.wsClient.close({ force: true })
      this.wsClient = null
    }
  }

  /** Access the underlying SDK client for outbound API calls. */
  get client(): Lark.Client {
    return this.sdk
  }

  private waitForAbort(_dispatcher: Lark.EventDispatcher, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        this.disconnect()
        resolve()
        return
      }
      signal?.addEventListener(
        'abort',
        () => {
          this.disconnect()
          resolve()
        },
        { once: true },
      )
    })
  }
}
