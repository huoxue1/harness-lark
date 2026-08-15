/**
 * harness-lark — Lark/Feishu channel plugin for DeepSeek Harness.
 *
 * A dsh bundle that mounts a Feishu WebSocket event gateway, maps each
 * Feishu conversation to a persistent dsh agent, and sends committed
 * assistant text back to the originating chat. Communication follows the
 * openclaw-lark design: `@larksuiteoapi/node-sdk` WSClient long connection
 * plus EventDispatcher routing.
 *
 * @module harness-lark
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { AgentBridge } from './agent/bridge.ts'
import { monitorFeishuProvider } from './channel/monitor.ts'
import { Config, type HarnessLarkConfig } from './core/config-schema.ts'
import { LarkClient } from './core/lark-client.ts'
import { hydrateTokens, initTokenPersistence, type StoredTokenRecord } from './core/token-store.ts'
import { registerFeishuTools } from './tools/index.ts'

export { Config }
export type { HarnessLarkConfig }
export { LarkClient } from './core/lark-client.ts'
export { AgentBridge } from './agent/bridge.ts'
export { monitorFeishuProvider } from './channel/monitor.ts'
export { parseMessageEvent } from './messaging/inbound/parse.ts'
export { MessageDedup } from './messaging/inbound/dedup.ts'
export { sendText, sendCard, updateCard } from './messaging/outbound/deliver.ts'
export {
  uploadImage,
  uploadFile,
  downloadMessageResource,
  sendImage,
  sendFile,
  sendAudio,
} from './messaging/outbound/media.ts'
export { addReaction, removeReaction, removeReactionByEmoji } from './messaging/outbound/reactions.ts'
export { runCommand } from './agent/commands.ts'
export { StreamingCard } from './card/streaming-card.ts'
export {
  buildThinkingCard,
  buildStreamingCard,
  buildCompleteCard,
  buildErrorCard,
  splitReasoningText,
  stripReasoningTags,
} from './card/builder.ts'
export type { MessageContext, FeishuMessageEvent } from './core/types.ts'

/** Stable Cordis plugin name. */
export const name = 'harness-lark'

/** Core services required before the gateway can bridge messages. */
export const inject = ['agents', 'tools']

/** Mount the Feishu gateway and agent bridge. */
export function apply(ctx: Context, config: HarnessLarkConfig): void {
  const logger = ctx.logger
  const accountId = 'default'

  // Persist user OAuth tokens through dsh's built-in settings store (a
  // `harness-lark` namespace in `~/.dsh/settings.yaml`, inside the persisted
  // data volume) so authorization survives process restarts. Optional: when no
  // settings service is mounted, tokens stay in memory for the session.
  installTokenPersistence(ctx)

  // No credentials configured: mount the tool family so agents can still use
  // Feishu APIs when a deployment supplies credentials later, but skip the
  // WebSocket gateway (its startup would fail loud and take the profile down).
  if (!config.appId || !config.appSecret) {
    logger.warn('[harness-lark] appId/appSecret not configured — skipping WebSocket gateway; set FEISHU_APP_ID / FEISHU_APP_SECRET to enable')
    const larkStub = new LarkClient({
      accountId,
      appId: config.appId ?? '',
      appSecret: config.appSecret ?? '',
      encryptKey: config.encryptKey ?? '',
      verificationToken: config.verificationToken ?? '',
      brand: config.brand,
      config,
    })
    registerFeishuTools(ctx, () => larkStub)
    return
  }

  // One LarkClient owns both the inbound WebSocket and outbound HTTP.
  const lark = new LarkClient({
    accountId,
    appId: config.appId,
    appSecret: config.appSecret,
    encryptKey: config.encryptKey ?? '',
    verificationToken: config.verificationToken ?? '',
    brand: config.brand,
    config,
  })

  const bridge = new AgentBridge(ctx, {
    config,
    accountId,
    client: () => lark,
  })

  // Register the Feishu tool families against the plugin's Lark client.
  registerFeishuTools(ctx, () => lark)

  // Registrations are effects that unwind when the plugin unloads.
  ctx.effect(() => {
    const signal = new AbortController()
    const monitorPromise = monitorFeishuProvider({
      config,
      accountId,
      bridge,
      lark,
      abortSignal: signal.signal,
    }).catch((error: unknown) => {
      logger.error(`[harness-lark] gateway failed: ${error instanceof Error ? error.message : String(error)}`)
    })

    return () => {
      signal.abort()
      void bridge.dispose()
      void monitorPromise
    }
  })

  logger.info(`[harness-lark] mounted (brand=${config.brand}, mode=${config.connectionMode})`)
}

/** One user token record persisted under the `harness-lark` settings namespace. */
const UatTokenRecordSchema = Schema.object({
  accessToken: Schema.string(),
  refreshToken: Schema.string(),
  expiresAt: Schema.number(),
  refreshExpiresAt: Schema.number(),
  scope: Schema.string(),
})

/** Settings namespace section: `{ tokens: { [openId]: record } }`. */
const UatSectionSchema = Schema.object({
  tokens: Schema.dict(UatTokenRecordSchema).default({}),
})

/**
 * Wire the in-memory token store to dsh's `ctx.settings` store: hydrate from
 * the persisted document at startup and write every mutation through. A no-op
 * when no settings service is mounted (tests, minimal profiles).
 */
function installTokenPersistence(ctx: Context): void {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(settingsNamespace('harness-lark'), UatSectionSchema)
    const section = scope.get() as { tokens?: Record<string, unknown> }
    hydrateTokens(
      Object.entries(section.tokens ?? {}).map(([openId, token]) => ({
        openId,
        token: token as StoredTokenRecord,
      })),
    )
    initTokenPersistence(async (entries) => {
      const tokens: Record<string, unknown> = {}
      for (const { openId, token } of entries) tokens[openId] = token
      await scope.replace({ tokens })
    })
  })
}
