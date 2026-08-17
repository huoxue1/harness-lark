/**
 * Slash-command handlers for harness-lark: /status, /model, /cd, /permission,
 * /setting.
 *
 * Commands are matched on inbound message text before it reaches the agent.
 * Each handler returns the reply text sent back to the chat (plain text, not
 * a model turn). State changes (model switch, cwd, permission preset) apply
 * to the chat's session and persist in the durable session log; /setting
 * writes dsh settings, which persist across restarts.
 */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { LarkClient } from '../core/lark-client.ts'
import { resolveRequestScope } from '../core/app-scopes.ts'
import { requestDeviceAuthorization } from '../core/device-flow.ts'
import { USER_SCOPES } from '../core/tool-scopes.ts'

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
  /** The Lark client, for auth/doctor diagnostics. */
  client: LarkClient
  /** The message sender's open_id (for /feishu auth scoping). */
  senderOpenId: string
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
  // Group chats require mentioning the bot, and resolveMentions turns the
  // mention key into "@昵称 " (or "@用户ID "). Strip a leading @-mention so
  // "@机器人 /status" still parses as a command.
  const trimmed = stripLeadingMention(text.trim())
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
    case '/setting':
      return await setting(arg, cmdCtx)
    case '/new':
    case '/reset':
      return reset(cmdCtx)
    case '/stop':
      return stop(cmdCtx)
    case '/feishu':
      return await feishu(arg, cmdCtx)
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

/** Minimal structural face of the dsh permission-presets service. */
interface PermissionPresetsService {
  /** Every switchable preset name. */
  readonly names: readonly string[]
  /** The effective preset for a session's event log. */
  current(events: readonly SessionEvent[]): string
  /** Record a changed preset and update the session's sandbox/approval knobs. */
  set(session: Session, name: string): void
}

function permission(arg: string, ctx: CommandContext): CommandResult {
  const presets = ctx.agent.ctx.get('permissionPresets') as PermissionPresetsService | undefined
  if (presets === undefined) {
    return {
      reply: '当前环境未注册权限预设服务（permissionPresets），无法切换会话权限。',
      handled: true,
    }
  }
  const session = ctx.agent.session
  if (!arg) {
    const current = presets.current(session.events)
    const lines = [
      '🔐 会话权限',
      `当前预设: ${current}`,
      '',
      '可用预设:',
      ...presets.names.map((name) => `  ${name}${name === current ? '（当前）' : ''}`),
      '',
      '切换: /permission <预设名>，例如 /permission danger-full-access',
      '说明: read-only 只读；workspace-write 可写工作区；danger-full-access 完全访问（可写任意路径，如 /root/.dsh）',
    ]
    return { reply: lines.join('\n'), handled: true }
  }
  if (!presets.names.includes(arg)) {
    return {
      reply: `未知预设 "${arg}"。可用: ${presets.names.join(', ')}。`,
      handled: true,
    }
  }
  try {
    presets.set(session, arg)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { reply: `❌ 切换预设失败: ${message}`, handled: true }
  }
  return {
    reply: `✅ 会话权限已切换: ${arg}\n（对后续的工具调用生效，含 bash/文件操作）`,
    handled: true,
  }
}

/** The dsh permission settings namespace (registered by dsh-permission-presets). */
const PERMISSION_SETTINGS_NAMESPACE = settingsNamespace('permission')

/** Minimal face of the permission settings section. */
interface PermissionSettingsSection {
  /** Preset pinned into newly created sessions. */
  defaultPreset?: string
}

/**
 * /setting — inspect or change plugin/deployment settings.
 * `permission` subcommand: read or write the default permission preset for
 * new sessions. The value lives in the dsh settings document
 * (`permission.defaultPreset`), so it persists across restarts and applies
 * to sessions created after the change; existing sessions are untouched
 * (switch those with /permission).
 */
async function setting(subcommand: string, ctx: CommandContext): Promise<CommandResult> {
  const sub = subcommand.trim()
  if (sub === '' || sub === 'permission') {
    return await settingPermission('', ctx)
  }
  if (sub.startsWith('permission ')) {
    return await settingPermission(sub.slice('permission '.length).trim(), ctx)
  }
  if (sub === 'model') {
    return await settingModel('', ctx)
  }
  if (sub.startsWith('model ')) {
    return await settingModel(sub.slice('model '.length).trim(), ctx)
  }
  return {
    reply: `未知设置项: "${sub}"。可用: permission（默认权限预设）、model（默认模型）`,
    handled: true,
  }
}

/** Minimal face of dsh's agentDefaultModel service. */
interface AgentDefaultModelService {
  /** Read the current default model selection. */
  currentSelection(): ModelSelection
  /** Persist the default model selection (provider/model/reasoningEffort). */
  saveSelection(next: ModelSelection): Promise<void>
}

/** Read or write the default model selection for new sessions. */
async function settingModel(arg: string, ctx: CommandContext): Promise<CommandResult> {
  const service = ctx.agent.ctx.get('agentDefaultModel') as AgentDefaultModelService | undefined
  if (service === undefined) {
    return { reply: '当前环境未注册默认模型服务（agentDefaultModel），无法设置默认模型。', handled: true }
  }
  if (!arg) {
    let current: ModelSelection
    try {
      current = service.currentSelection()
    } catch {
      return { reply: '当前未设置默认模型，用 /setting model <provider/model> 设置。', handled: true }
    }
    const list = ctx.availableModels
      .map((m) => {
        const mark = current.provider === m.provider && current.model === m.model ? ' *' : ''
        return `  ${m.provider}/${m.model}${mark}`
      })
      .join('\n')
    return {
      reply: `⚙️ 默认模型设置\n当前默认: ${current.provider}/${current.model}\n\n可用模型:\n${list}\n\n设置: /setting model <provider/model>，例如 /setting model deepseek-official/deepseek-v4-flash\n说明: 默认模型作用于之后新建的会话；当前会话用 /model 切换`,
      handled: true,
    }
  }
  // Match provider/model or model only, like /model.
  const target = arg.split('/')
  const provider = target.length === 2 ? target[0] : undefined
  const modelName = target.length === 2 ? target[1] : target[0]
  const match = ctx.availableModels.find((m) =>
    (provider === undefined || m.provider === provider) && m.model === modelName,
  )
  if (!match) {
    return { reply: `未找到模型 "${arg}"。用 /setting model 查看可用列表。`, handled: true }
  }
  try {
    await service.saveSelection({ provider: match.provider, model: match.model })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { reply: `❌ 设置默认模型失败: ${message}`, handled: true }
  }
  return {
    reply: `✅ 默认模型已设置为: ${match.provider}/${match.model}\n（作用于之后新建的会话；当前会话用 /model 切换）`,
    handled: true,
  }
}

/** Read or write the default permission preset for new sessions. */
async function settingPermission(arg: string, ctx: CommandContext): Promise<CommandResult> {
  const settings = ctx.agent.ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) {
    return { reply: '当前环境未注册 settings 服务，无法读取/设置默认权限。', handled: true }
  }
  const section = settings.get(PERMISSION_SETTINGS_NAMESPACE) as PermissionSettingsSection | undefined
  if (!arg) {
    const current = section?.defaultPreset ?? '（未设置，使用部署默认）'
    const presets = ctx.agent.ctx.get('permissionPresets') as PermissionPresetsService | undefined
    const names = presets === undefined ? [] : [...presets.names]
    const lines = [
      '⚙️ 默认权限设置',
      `当前默认: ${current}`,
      '',
      '可用预设:',
      ...(names.length > 0 ? names.map((name) => `  ${name}`) : ['  （权限预设服务不可用）']),
      '',
      '设置: /setting permission <预设名>，例如 /setting permission workspace-write',
      '说明: 默认权限作用于新建会话；切换当前会话用 /permission',
    ]
    return { reply: lines.join('\n'), handled: true }
  }
  const presets = ctx.agent.ctx.get('permissionPresets') as PermissionPresetsService | undefined
  if (presets !== undefined && !presets.names.includes(arg)) {
    return { reply: `未知预设 "${arg}"。可用: ${presets.names.join(', ')}。`, handled: true }
  }
  try {
    await settings.update(PERMISSION_SETTINGS_NAMESPACE, { defaultPreset: arg })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { reply: `❌ 设置默认权限失败: ${message}`, handled: true }
  }
  return {
    reply: `✅ 默认权限已设置为: ${arg}\n（作用于之后新建的会话；当前会话用 /permission 切换）`,
    handled: true,
  }
}

function stop(ctx: CommandContext): CommandResult {
  // Cancel the active turn (keepInbox=true so queued messages survive; /new is
  // the explicit full reset). dsh's Agent.cancel aborts the live turn or
  // between-turn task with a user cause.
  try {
    ctx.agent.cancel({ kind: 'user' }, { keepInbox: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { reply: `❌ 停止失败: ${message}`, handled: true }
  }
  return { reply: '🛑 已请求停止当前回复。', handled: true }
}

function reset(ctx: CommandContext): CommandResult {
  void ctx
  return {
    reply: '已新建上下文，之前的对话历史已清空。',
    handled: true,
    resetContext: true,
  }
}

/**
 * /feishu auth | /feishu doctor — Feishu plugin subcommands.
 * `auth` starts the device authorization flow for the sender; `doctor`
 * runs a diagnostics report over credentials, bot identity, and connection.
 */
async function feishu(subcommand: string, ctx: CommandContext): Promise<CommandResult> {
  const sub = subcommand.toLowerCase()
  if (sub === 'auth' || sub === '') {
    return await feishuAuth(ctx)
  }
  if (sub === 'doctor') {
    return await feishuDoctor(ctx)
  }
  return { reply: `未知的 /feishu 子命令: "${subcommand}"。可用: auth, doctor`, handled: true }
}

/** /feishu auth — device authorization flow for the sender. */
async function feishuAuth(ctx: CommandContext): Promise<CommandResult> {
  const client = ctx.client
  try {
    // Request only the scopes the app has actually granted (dynamic filter).
    const { scope, filteredOut, permissionUrl } = await resolveRequestScope(client)
    if (!scope.trim()) {
      return {
        reply:
          '❌ 无法发起授权：应用未开通任何所需的用户权限。\n' +
          `请在开放平台开通后重试：${permissionUrl}\n` +
          `需要的权限：${USER_SCOPES.join(', ')}`,
        handled: true,
      }
    }
    const auth = await requestDeviceAuthorization({
      appId: client.account.appId,
      appSecret: client.account.appSecret,
      brand: client.account.brand,
      scope,
    })
    // Poll in the background; store the token on success.
    const openId = ctx.senderOpenId || 'self'
    const { pollDeviceToken } = await import('../core/device-flow.ts')
    const { setStoredToken } = await import('../core/token-store.ts')
    void pollDeviceToken({
      appId: client.account.appId,
      appSecret: client.account.appSecret,
      brand: client.account.brand,
      deviceCode: auth.deviceCode,
      interval: auth.interval,
      expiresIn: auth.expiresIn,
    }).then((result) => {
      if (result.ok) {
        setStoredToken(openId, {
          accessToken: result.token.accessToken,
          refreshToken: result.token.refreshToken,
          expiresIn: result.token.expiresIn,
          scope: result.token.scope,
        })
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[harness-lark] /feishu auth poll failed: ${message}`)
    })
    const filteredNote = filteredOut.length > 0
      ? `\n\n（已跳过应用未开通的 ${filteredOut.length} 项权限：${filteredOut.join(', ')}；如需开通：${permissionUrl}）`
      : ''
    return {
      reply:
        '✅ 已发起授权请求\n\n' +
        `请在浏览器打开: ${auth.verificationUri}\n` +
        `输入用户码: ${auth.userCode}\n` +
        `（有效期 ${Math.round(auth.expiresIn / 60)} 分钟）` +
        filteredNote,
      handled: true,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { reply: `❌ 授权失败: ${message}`, handled: true }
  }
}

/** /feishu doctor — diagnostics report. */
async function feishuDoctor(ctx: CommandContext): Promise<CommandResult> {
  const client = ctx.client
  const account = client.account
  const lines: string[] = ['🩺 飞书插件诊断报告', '']

  // Credentials.
  const appId = account.appId
  const appSecret = account.appSecret
  lines.push('📋 基础信息')
  lines.push(`  app_id: ${appId || '（未设置）'}`)
  lines.push(`  app_secret: ${appSecret ? '已设置 ✓' : '（未设置）✗'}`)
  lines.push(`  平台: ${account.brand}`)
  lines.push(`  连接模式: ${account.config.connectionMode}`)
  lines.push('')

  // Bot identity.
  lines.push('🤖 机器人身份')
  lines.push(`  bot open_id: ${client.botOpenId ?? '（未知，probe 未成功）'}`)
  lines.push(`  bot 名称: ${client.botName ?? '（未知）'}`)
  lines.push(`  WS 连接: ${client.wsConnected ? '已连接 ✓' : '未连接 ✗'}`)
  lines.push('')

  // Model config.
  const sel = ctx.selection.current
  lines.push('🧠 模型配置')
  lines.push(`  当前模型: ${sel ? `${sel.provider}/${sel.model}` : '（默认）'}`)
  lines.push(`  工作目录: ${ctx.cwd.value}`)
  lines.push('')

  // OAuth token status.
  const openId = ctx.senderOpenId
  if (openId) {
    const { tokenStatus } = await import('../core/token-store.ts')
    const status = tokenStatus(openId)
    lines.push('🔐 用户授权')
    lines.push(`  OAuth: ${status.authorized ? '已授权 ✓' : '未授权（可用 /feishu auth 发起）'}`)
    lines.push('')
  }

  lines.push('💡 提示: /feishu auth 发起授权；/status 查看会话状态')
  return { reply: lines.join('\n'), handled: true }
}

function help(): CommandResult {
  return {
    reply:
      '可用命令:\n' +
      '  /status        查看当前模型、工作目录、会话状态\n' +
      '  /model         查看可用模型（/model <provider/model> 切换）\n' +
      '  /cd            查看/修改工作目录（/cd <绝对路径>）\n' +
      '  /new           新建上下文（清空当前对话历史）\n' +
      '  /stop          停止当前正在进行的回复\n' +
      '  /feishu auth   发起飞书用户授权\n' +
      '  /feishu doctor 运行飞书插件诊断\n' +
      '  /permission    查看/切换会话权限预设（/permission <预设名>）\n' +
      '  /setting       查看设置项；/setting permission [预设名] 设置默认权限；/setting model [模型] 设置默认模型\n' +
      '  /help          显示本帮助',
    handled: true,
  }
}

/** Strip a leading "@昵称 " (or "@用户ID ") mention prefix from a command. */
function stripLeadingMention(text: string): string {
  // Feishu mention keys are `at_xxx`; resolveMentions rewrites `@at_xxx` to
  // `@名` and bare `at_xxx` to `@名`. Match one leading `@<非空白> ` segment.
  const match = /^@\S+\s+/.exec(text)
  return match ? text.slice(match[0].length) : text
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}
