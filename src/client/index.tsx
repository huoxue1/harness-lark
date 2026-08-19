/**
 * Client half of harness-lark: registers the "飞书" settings section (agents
 * management) in the DSH Settings shell. The form reads/writes the
 * `harness-lark` settings namespace through the plugin-owned
 * `/lark/api/settings.*` routes (the DSH settings RPC domain does not serve
 * third-party namespaces to configuration clients).
 *
 * The section follows the DSH settings recipes: an intro line, one container
 * card per agent (PluginCard recipe) whose fields are settings rows, and a
 * footer with the add/save actions plus the wire status line.
 *
 * @module harness-lark/client
 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  Button,
  IconCheckOutline16,
  IconPlusOutline16,
  IconTrashOutline16,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './AgentsSection.module.css'

/** One Feishu agent as configured in settings (mirror of the host type). */
export interface FeishuAgentConfig {
  id: string
  appId: string
  appSecret: string
  cwd?: string
  agentsMd?: string
  chats?: string[]
  default?: boolean
}

/** The settings API wire shape. */
interface SettingsGetResponse {
  ok: boolean
  agents?: FeishuAgentConfig[]
  error?: { code?: string; message?: string }
}

/** POST one settings API method with a JSON body. */
async function callSettings(method: string, body: unknown = {}): Promise<SettingsGetResponse> {
  const res = await fetch(`/lark/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await res.json() as SettingsGetResponse
}

/** Fresh blank agent row. */
function blankAgent(): FeishuAgentConfig {
  return { id: '', appId: '', appSecret: '' }
}

/** One labeled input row (title/desc left, control right). */
function FieldRow(props: {
  title: string
  desc: string
  control: ReactNode
}): ReactElement {
  return (
    <div className={css.row}>
      <span className={css.rowText}>
        <span className={css.title}>{props.title}</span>
        <span className={css.desc}>{props.desc}</span>
      </span>
      <span className={css.control}>{props.control}</span>
    </div>
  )
}

/** One agent card: heading + field rows. */
function AgentCard(props: {
  agent: FeishuAgentConfig
  index: number
  onChange: (index: number, patch: Partial<FeishuAgentConfig>) => void
  onRemove: (index: number) => void
}): ReactElement {
  const { agent, index, onChange, onRemove } = props
  const set = (patch: Partial<FeishuAgentConfig>): void => onChange(index, patch)
  return (
    <section className={css.group}>
      <div className={css.heading}>
        <span className={css.headingTitle}>
          {agent.id !== '' ? agent.id : `Agent ${index + 1}`}
        </span>
        {agent.default === true && <span className={css.badge}>默认</span>}
        <button
          type="button"
          className={css.remove}
          aria-label="删除 agent"
          onClick={() => onRemove(index)}
        >
          <IconTrashOutline16 />
        </button>
      </div>
      <FieldRow
        title="Agent ID"
        desc="唯一标识，用于路由"
        control={(
          <Input
            className={css.fieldInput}
            value={agent.id}
            placeholder="例如 default / ops"
            onChange={(e) => set({ id: e.currentTarget.value })}
          />
        )}
      />
      <FieldRow
        title="App ID"
        desc="飞书应用的 appId"
        control={(
          <Input
            className={css.fieldInput}
            value={agent.appId}
            placeholder="cli_xxxxxxxx"
            spellCheck={false}
            onChange={(e) => set({ appId: e.currentTarget.value })}
          />
        )}
      />
      <FieldRow
        title="App Secret"
        desc="飞书应用的 appSecret"
        control={(
          <Input
            className={css.fieldInput}
            type="password"
            value={agent.appSecret}
            placeholder="••••••••"
            spellCheck={false}
            onChange={(e) => set({ appSecret: e.currentTarget.value })}
          />
        )}
      />
      <FieldRow
        title="工作目录"
        desc="agent 的默认 cwd（可选）"
        control={(
          <Input
            className={css.fieldInput}
            value={agent.cwd ?? ''}
            placeholder="例如 /work/ops"
            onChange={(e) => set({ cwd: e.currentTarget.value })}
          />
        )}
      />
      <FieldRow
        title="Chats"
        desc="路由到该 agent 的会话（逗号分隔：oc_… 或 p2p/group）"
        control={(
          <Input
            className={css.fieldInput}
            value={(agent.chats ?? []).join(', ')}
            placeholder="oc_xxx, p2p, group"
            onChange={(e) => set({
              chats: e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean),
            })}
          />
        )}
      />
      <div className={css.block}>
        <span className={css.blockLabel}>AGENTS.md 指令</span>
        <textarea
          className={css.textarea}
          value={agent.agentsMd ?? ''}
          placeholder="写入该 agent 工作目录的指令（可选）"
          onChange={(e) => set({ agentsMd: e.currentTarget.value })}
        />
      </div>
      <div className={css.row}>
        <span className={css.rowText}>
          <span className={css.title}>默认 agent</span>
          <span className={css.desc}>未匹配 chat 规则时兜底</span>
        </span>
        <label className={css.switch}>
          <input
            type="checkbox"
            className={css.switchInput}
            checked={agent.default === true}
            onChange={(e) => set({ default: e.currentTarget.checked })}
          />
          <span className={css.switchTrack}>
            <span className={css.switchThumb} />
          </span>
        </label>
      </div>
    </section>
  )
}

/** The agents management section body (settings.section entry). */
export function AgentsSection(): ReactElement {
  const [agents, setAgents] = useState<FeishuAgentConfig[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void callSettings('settings.get').then((res) => {
      if (cancelled) return
      if (res.ok && Array.isArray(res.agents)) {
        setAgents(res.agents)
      } else {
        setError(res.error?.message ?? '读取配置失败')
      }
    }).catch(() => {
      if (!cancelled) setError('读取配置失败（网络错误）')
    })
    return () => { cancelled = true }
  }, [])

  const updateAgent = (index: number, patch: Partial<FeishuAgentConfig>): void => {
    setAgents((prev) => {
      if (!prev) return prev
      const next = prev.map((agent, i) => (i === index ? { ...agent, ...patch } : agent))
      return next
    })
    setSaved(false)
  }

  const addAgent = (): void => {
    setAgents((prev) => [...(prev ?? []), blankAgent()])
    setSaved(false)
  }

  const removeAgent = (index: number): void => {
    setAgents((prev) => prev?.filter((_, i) => i !== index))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    setError(undefined)
    try {
      const res = await callSettings('settings.set', { agents })
      if (res.ok) {
        setSaved(true)
        setAgents(res.agents ?? agents)
      } else {
        setError(res.error?.message ?? '保存失败')
      }
    } catch {
      setError('保存失败（网络错误）')
    }
  }

  if (agents === undefined) {
    return <div className={css.loading}>加载中…</div>
  }

  return (
    <div className={css.section}>
      <p className={css.intro}>
        每个 agent 对应一个飞书应用（可共享同一 appId/secret），按 chat 路由。修改后重启生效。
      </p>
      {agents.map((agent, index) => (
        <AgentCard
          key={agent.id !== '' ? agent.id : `index-${index}`}
          agent={agent}
          index={index}
          onChange={updateAgent}
          onRemove={removeAgent}
        />
      ))}
      <div className={css.footer}>
        <Button variant="outline" icon={<IconPlusOutline16 />} onClick={addAgent}>
          添加 agent
        </Button>
        <Button variant="primary" icon={<IconCheckOutline16 />} onClick={() => void save()}>
          保存
        </Button>
        {saved && <span className={`${css.status} ${css.statusSaved}`}>已保存（重启生效）</span>}
        {error !== undefined && <span className={`${css.status} ${css.statusError}`}>{error}</span>}
      </div>
    </div>
  )
}

/** Required services before the client entry mounts. */
export const inject = ['slots', 'sessions']

/** Client plugin body: register the 飞书 settings section. */
export function apply(ctx: Context): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'lark',
    order: 50,
    label: '飞书',
  }, AgentsSection))
}

export type { Context as LarkClientContext, ClientContext }
