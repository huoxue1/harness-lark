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
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentBridge } from './agent/bridge.ts'
import { installFeishuApproval } from './approval/feishu-approval.ts'
import { installFeishuAskUser } from './interaction/ask-user.ts'
import { monitorFeishuProvider } from './channel/monitor.ts'
import { Config, type HarnessLarkAgent, type HarnessLarkConfig } from './core/config-schema.ts'
import { LarkClient } from './core/lark-client.ts'
import type { MessageContext } from './core/types.ts'
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

/** Mount the Feishu gateways and agent bridges, one per configured agent. */
export function apply(ctx: Context, config: HarnessLarkConfig): void {
  const logger = ctx.logger

  // Persist user OAuth tokens through dsh's built-in settings store (a
  // `harness-lark` namespace in `~/.dsh/settings.yaml`, inside the persisted
  // data volume) so authorization survives process restarts, and expose the
  // multi-agent configuration section to the Web settings surface.
  const { resolveAgents } = installSettingsIntegration(ctx, config)
  const agents = resolveAgents()

  if (agents.length === 0) {
    logger.warn('[harness-lark] no Feishu app configured — skipping gateways; set FEISHU_APP_ID / FEISHU_APP_SECRET or configure agents in settings')
    const larkStub = new LarkClient({
      accountId: 'default',
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

  // Group agents by appId: one Feishu app = one WebSocket connection, with
  // messages routed by chat to the serving agent's bridge.
  const byApp = new Map<string, HarnessLarkAgent[]>()
  const disposers: Array<() => void> = []
  for (const agent of agents) {
    const cwd = agent.cwd ?? process.cwd()
    // Write workspace instructions so dsh's agent-instructions loads them
    // (AGENTS.md discovery walks up from the session cwd).
    if (agent.agentsMd && agent.agentsMd.trim().length > 0) {
      writeWorkspaceInstructions(cwd, agent.agentsMd)
    }
    const group = byApp.get(agent.appId) ?? []
    group.push(agent)
    byApp.set(agent.appId, group)
  }

  for (const [appId, group] of byApp) {
    const lark = new LarkClient({
      accountId: appId,
      appId,
      appSecret: group[0]!.appSecret,
      encryptKey: group[0]!.encryptKey ?? '',
      verificationToken: group[0]!.verificationToken ?? '',
      brand: config.brand,
      config,
    })

    // Build one bridge per agent in the group (own cwd + ask/approval wiring).
    const bridgeEntries: Array<{ agent: HarnessLarkAgent; bridge: AgentBridge; askUser: ReturnType<typeof installFeishuAskUser>; approval: ReturnType<typeof installFeishuApproval> }> = []
    for (const agent of group) {
      const accountId = agent.id || 'default'
      const cwd = agent.cwd ?? process.cwd()
      const askUser = installFeishuAskUser(ctx, {
        client: () => lark,
        chatIdOf: (sessionId) => chatIdOfSession(sessionId),
        timeoutMs: config.askTimeoutMs,
      })
      const bridge = new AgentBridge(ctx, {
        config,
        accountId,
        client: () => lark,
        registerAskUserTool: (agentCtx) => askUser.registerTool(agentCtx),
        onChatMessage: (sessionId, text) => askUser.handleChatMessage(sessionId, text),
        defaultCwd: cwd,
      })
      const approval = installFeishuApproval(ctx, {
        client: () => lark,
        timeoutMs: config.approvalTimeoutMs,
      })
      registerFeishuTools(ctx, () => lark)
      bridgeEntries.push({ agent, bridge, askUser, approval })
    }

    // Route one parsed message: exact chat id or chat-type tag match first,
    // then the group's default agent (or the first agent) as fallback.
    const route = (message: MessageContext): AgentBridge | undefined => {
      for (const { agent, bridge } of bridgeEntries) {
        const rules = agent.chats
        if (rules === undefined || rules.length === 0) {
          // A single-agent group serves everything; a multi-agent group
          // without rules treats each entry as a fallback candidate.
          if (bridgeEntries.length === 1) return bridge
          continue
        }
        if (rules.includes(message.chatId) || rules.includes(message.chatType)) return bridge
      }
      const fallback = bridgeEntries.find(({ agent }) => agent.default === true) ?? bridgeEntries[0]
      return fallback?.bridge
    }

    const signal = new AbortController()
    const monitorPromise = monitorFeishuProvider({
      config,
      accountId: appId,
      bridge: route,
      lark,
      abortSignal: signal.signal,
      onCardAction: [
        ...bridgeEntries.flatMap(({ approval, askUser }) => [
          (data: unknown) => approval.handleCardAction(data),
          (data: unknown) => askUser.handleCardAction(data),
        ]),
      ],
    }).catch((error: unknown) => {
      logger.error(`[harness-lark] gateway failed for app ${appId}: ${error instanceof Error ? error.message : String(error)}`)
    })

    disposers.push(() => {
      signal.abort()
      for (const { bridge, askUser, approval } of bridgeEntries) {
        approval.dispose()
        askUser.dispose()
        void bridge.dispose()
      }
      void monitorPromise
    })
    logger.info(`[harness-lark] mounted app ${appId} with ${bridgeEntries.length} agent(s) (brand=${config.brand}, mode=${config.connectionMode})`)
  }

  // Registrations are effects that unwind when the plugin unloads.
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  })
}

/** One user token record persisted under the `harness-lark` settings namespace. */
const UatTokenRecordSchema = Schema.object({
  accessToken: Schema.string(),
  refreshToken: Schema.string(),
  expiresAt: Schema.number(),
  refreshExpiresAt: Schema.number(),
  scope: Schema.string(),
})

/** Settings section for one configured Feishu agent. */
const AgentSettingsSchema = Schema.object({
  id: Schema.string().required(),
  appId: Schema.string().required(),
  appSecret: Schema.string().required(),
  encryptKey: Schema.string(),
  verificationToken: Schema.string(),
  cwd: Schema.string(),
  agentsMd: Schema.string(),
  chats: Schema.array(Schema.string()),
  default: Schema.boolean(),
})

/** Settings namespace section: `{ tokens, agents }`. */
const HarnessLarkSectionSchema = Schema.object({
  tokens: Schema.dict(UatTokenRecordSchema).default({}),
  agents: Schema.array(AgentSettingsSchema).default([]),
})

/** Settings shape resolved from the `harness-lark` namespace. */
interface HarnessLarkSettings {
  tokens?: Record<string, unknown>
  agents?: HarnessLarkAgent[]
}

/**
 * Wire the in-memory token store to dsh's `ctx.settings` store: hydrate from
 * the persisted document at startup and write every mutation through. A no-op
 * when no settings service is mounted (tests, minimal profiles). Also exposes
 * the multi-agent configuration section for the Web settings surface.
 */
function installSettingsIntegration(ctx: Context, config: HarnessLarkConfig): {
  /** Agents from settings when configured; falls back to config/env. */
  resolveAgents: () => HarnessLarkAgent[]
} {
  let storedAgents: HarnessLarkAgent[] | undefined
  ctx.inject(['settings'], (sctx) => {
    const registered = sctx.settings.register(settingsNamespace('harness-lark'), HarnessLarkSectionSchema)
    const section = registered.get() as HarnessLarkSettings
    storedAgents = section.agents
    hydrateTokens(
      Object.entries(section.tokens ?? {}).map(([openId, token]) => ({
        openId,
        token: token as StoredTokenRecord,
      })),
    )
    initTokenPersistence(async (entries) => {
      const tokens: Record<string, unknown> = {}
      for (const { openId, token } of entries) tokens[openId] = token
      await registered.replace({ tokens })
    })
  })

  const resolveAgents = (): HarnessLarkAgent[] => {
    if (storedAgents !== undefined && storedAgents.length > 0) return storedAgents
    if (config.agents !== undefined && config.agents.length > 0) return config.agents
    // Legacy single-agent: environment variables (FEISHU_APP_ID/SECRET) or the
    // top-level config appId/appSecret.
    const appId = process.env.FEISHU_APP_ID ?? config.appId ?? ''
    const appSecret = process.env.FEISHU_APP_SECRET ?? config.appSecret ?? ''
    if (!appId || !appSecret) return []
    return [{ id: 'default', appId, appSecret }]
  }

  return { resolveAgents }
}

/**
 * Resolve the Feishu chat id from a session id.
 * Session ids look like `lark:<accountId>:<chatId>[:generation]` or
 * `lark:<accountId>:<chatId>:thread:<threadId>[:generation]`.
 * @param sessionId - the dsh session id.
 * @returns the `oc_...` chat id, or `undefined` for non-Feishu sessions.
 */
function chatIdOfSession(sessionId: string): string | undefined {
  if (!sessionId.startsWith('lark:')) return undefined
  const parts = sessionId.split(':')
  return parts[2]
}

/**
 * Write an agent's workspace instructions to `<cwd>/AGENTS.md`, creating the
 * directory when needed. dsh's agent-instructions plugin discovers AGENTS.md
 * by walking up from the session cwd, so the file becomes the agent's
 * baseline instructions automatically.
 * @param cwd - the agent's default working directory.
 * @param content - the AGENTS.md content.
 */
function writeWorkspaceInstructions(cwd: string, content: string): void {
  try {
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'AGENTS.md'), content, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[harness-lark] failed to write AGENTS.md at ${cwd}: ${message}`)
  }
}
