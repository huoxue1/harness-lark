/**
 * Slash-command handlers for harness-lark: /status, /model, /cd, /permission.
 *
 * Commands are matched on inbound message text before it reaches the agent.
 * Each handler returns the reply text sent back to the chat (plain text, not
 * a model turn). State changes (model switch, cwd) apply to the chat's record
 * and persist for the process lifetime.
 */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Per-chat mutable state a command handler may read or mutate. */
export interface CommandContext {
  /** The chat's agent (session header cwd is mutated by /cd). */
  agent: Agent
  /** The chat's current model selection (mutated by /model). */
  selection: { current: ModelSelection | undefined }
  /** Working directory for this chat (mutated by /cd via this mutable holder). */
  cwd: { value: string }
  /** List of available models (provider/model pairs). */
  availableModels: Array<{ provider: string; model: string }>
}

/** Result of a command: reply text plus optional state effects (applied already). */
export interface CommandResult {
  /** Plain-text reply sent to the chat. */
  reply: string
  /** True when the message was handled as a command (do not run the agent). */
  handled: boolean
  /** True when /new requested: the bridge disposes the agent and rebuilds a fresh one. */
  resetContext?: boolean
}

/**
 * Parse and execute a slash command.
 * @param text - the raw inbound message text.
 * @returns CommandResult; `handled` false when the text is not a command.
 */
export async function runCommand(text: string, cmdCtx: CommandContext): Promise<CommandResult> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return { reply: '', handled: false }

  const [command, ...rest] = trimmed.split(/\s+/)
  const arg = rest.join(' ').trim()
  const name = command!.toLowerCase()

  switch (name) {
    case '/status':
      return status(cmdCtx)
    case '/model':
      return await model(arg, cmdCtx)
    case '/cd':
      return cd(arg, cmdCtx)
    case '/permission':
    case '/perm':
      return permission(arg, cmdCtx)
    case '/new':
    case '/reset':
      return reset(cmdCtx)
    case '/help':
      return help()
    default:
      return { reply: `未知命令: ${command}。输入 /help 查看可用命令。`, handled: true }
  }
}

function status(ctx: CommandContext): CommandResult {
  const sel = ctx.selection.current
  const lines = [
    '📊 当前状态',
    `模型: ${sel ? `${sel.provider}/${sel.model}` : '（默认）'}`,
    `工作目录: ${ctx.cwd.value}`,
    `会话: ${ctx.agent.session.header.id}`,
  ]
  return { reply: lines.join('\n'), handled: true }
}

function model(arg: string, ctx: CommandContext): CommandResult {
  if (!arg) {
    // List available models + current.
    const current = ctx.selection.current
    const list = ctx.availableModels
      .map((m) => {
        const mark = current && current.provider === m.provider && current.model === m.model ? ' *' : ''
        return `  ${m.provider}/${m.model}${mark}`
      })
      .join('\n')
    return {
      reply: `当前模型: ${current ? `${current.provider}/${current.model}` : '（默认）'}\n可用模型:\n${list}\n\n切换: /model <provider/model>`,
      handled: true,
    }
  }
  // Match provider/model or model only.
  const target = arg.split('/')
  const provider = target.length === 2 ? target[0] : undefined
  const modelName = target.length === 2 ? target[1] : target[0]
  const match = ctx.availableModels.find((m) =>
    (provider === undefined || m.provider === provider) && m.model === modelName,
  )
  if (!match) {
    return { reply: `未找到模型 "${arg}"。用 /model 查看可用列表。`, handled: true }
  }
  ctx.selection.current = { provider: match.provider, model: match.model }
  return { reply: `已切换模型: ${match.provider}/${match.model}（下一轮生效）`, handled: true }
}

function cd(arg: string, ctx: CommandContext): CommandResult {
  if (!arg) {
    return { reply: `当前工作目录: ${ctx.cwd.value}\n修改: /cd <绝对路径>`, handled: true }
  }
  if (!isAbsolute(arg)) {
    return { reply: `工作目录必须是绝对路径，got "${arg}"`, handled: true }
  }
  // The session header cwd is immutable after creation; record the new cwd on
  // the chat state. It takes effect for the NEXT agent the bridge creates
  // (a future turn or after a restart), while /status reads it immediately.
  ctx.cwd.value = arg
  return { reply: `工作目录已切换: ${arg}（下次会话/重启后生效，当前会话仍为原目录）`, handled: true }
}

function permission(arg: string, ctx: CommandContext): CommandResult {
  // Placeholder for permission management; the real enforcement is config.
  void arg
  void ctx
  return {
    reply:
      '权限说明:\n' +
      '  私聊策略 (dmPolicy): open\n' +
      '  群聊策略 (groupPolicy): open\n' +
      '  群聊需 @机器人: false\n\n' +
      '修改权限需通过配置文件 cordis.patch.yml 的 dmPolicy/groupPolicy/allowlist 字段调整。',
    handled: true,
  }
}

function reset(ctx: CommandContext): CommandResult {
  void ctx
  return {
    reply: '已新建上下文，之前的对话历史已清空。',
    handled: true,
    resetContext: true,
  }
}

function help(): CommandResult {
  return {
    reply:
      '可用命令:\n' +
      '  /status      查看当前模型、工作目录、会话状态\n' +
      '  /model       查看可用模型（/model <provider/model> 切换）\n' +
      '  /cd          查看/修改工作目录（/cd <绝对路径>）\n' +
      '  /new         新建上下文（清空当前对话历史）\n' +
      '  /permission  查看权限配置说明\n' +
      '  /help        显示本帮助',
    handled: true,
  }
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}
