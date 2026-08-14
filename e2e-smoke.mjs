/**
 * End-to-end smoke test: real Feishu communication with a mock dsh agent.
 *
 * Boots a minimal Cordis context, mounts harness-lark's real bridge + WS
 * gateway with the real Feishu credentials, and simulates the agent side:
 * when a message arrives from Feishu, the mock agent replies with streamed
 * reasoning + answer text so the streaming card lifecycle (thinking ->
 * reasoning -> answer -> complete) can be observed in the Feishu chat.
 *
 * Run: node --env-file=.env e2e-smoke.mjs
 *       (then send a message to the bot in Feishu)
 *
 * Credentials come from the environment (FEISHU_APP_ID / FEISHU_APP_SECRET),
 * loaded from .env by --env-file. Never hardcode secrets in this file.
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as lark from './lib/index.mjs'

// Function plugin shape: { name, inject, Config, apply }
const harnessLark = { name: lark.name, inject: lark.inject, Config: lark.Config, apply: lark.apply }

// ── Feishu credentials from environment (.env is gitignored) ─────────────
const FEISHU_APP_ID = process.env.FEISHU_APP_ID
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error('[smoke] FEISHU_APP_ID / FEISHU_APP_SECRET not set — run with `node --env-file=.env e2e-smoke.mjs`')
  process.exit(1)
}

// ── Mock agent: echoes a streamed reply back ─────────────────────────────
async function main() {
  const ctx = new Context()

  // Real dsh registries so the bridge can create/resume sessions.
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)

  // Mock factory: agents are lightweight — followup() triggers a scripted
  // streaming reply (reasoning delta, then text deltas, then a message and
  // turn end) so the card lifecycle runs for real.
  ctx.agents.setFactory({
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create({ sessionId: options.sessionId, meta: options.meta })
      const agent = {
        id: options.sessionId,
        session,
        ctx: _ownerCtx,
        status: 'running',
        options: {},
        inbox: {
          append() {},
          nextTurn() { return [] },
          nextStep() { return [] },
        },
        followup(message) {
          void simulateReply(session, message)
        },
        inject() {},
        steer() {},
        cancel() {},
        async whenIdle() {},
      }
      return { agent, dispose: async () => {} }
    },
  })

  async function simulateReply(session, message) {
    const turn = 1
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('assistant/chunk', {
      turn, step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: '让我想想这个问题…' },
    })
    await sleep(1500)
    session.append('assistant/chunk', {
      turn, step: 1,
      chunk: { type: 'text-delta', index: 1, text: '你好！' },
    })
    await sleep(800)
    session.append('assistant/chunk', {
      turn, step: 1,
      chunk: { type: 'text-delta', index: 1, text: ' 我是 DeepSeek Harness 的飞书机器人。' },
    })
    await sleep(800)
    session.append('assistant/message', {
      turn, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '你好！ 我是 DeepSeek Harness 的飞书机器人。' }],
        source: { provider: 'mock', model: 'mock-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  // ── Mount the real harness-lark plugin ─────────────────────────────────
  const config = {
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    brand: 'feishu',
    connectionMode: 'websocket',
    dmPolicy: 'open',
    groupPolicy: 'disabled',
    requireMentionInGroups: true,
    replyMode: 'streaming',
    dedupTtlMs: 3600_000,
  }

  await ctx.plugin(harnessLark, config)
  console.log('[smoke] harness-lark mounted — WebSocket gateway starting...')
  console.log('[smoke] SEND A MESSAGE TO THE BOT IN FEISHU to see the streaming card reply.')
  console.log('[smoke] Press Ctrl+C to stop.')

  // Keep alive for 5 minutes.
  const timer = setTimeout(() => {
    console.log('[smoke] 5min elapsed — exiting')
    process.exit(0)
  }, 5 * 60_000)
  process.on('SIGINT', () => { clearTimeout(timer); process.exit(0) })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((error) => {
  console.error('[smoke] FAILED:', error)
  process.exit(1)
})
