/**
 * Client half of harness-lark: registers the "飞书" settings section (agents
 * management) in the DSH Settings shell. The form reads/writes the
 * `harness-lark` settings namespace through the plugin-owned
 * `/lark/api/settings.*` routes (the DSH settings RPC domain does not serve
 * third-party namespaces to configuration clients).
 *
 * @module harness-lark/client
 */

import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

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

/** The agents management section body (settings.section entry). */
export function AgentsSection(): JSX.Element {
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
    return <div>加载中...</div>
  }

  return (
    <div style={{ padding: '12px', maxWidth: '720px' }}>
      <h3 style={{ margin: '0 0 4px' }}>飞书 Agents</h3>
      <p style={{ margin: '0 0 12px', color: '#888' }}>
        每个 agent 对应一个飞书应用（可共享同一 appId/secret），按 chat 路由。修改后重启生效。
      </p>
      {agents.map((agent, index) => (
        <div key={index} style={{ border: '1px solid #ddd', borderRadius: '8px', padding: '10px', marginBottom: '10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <input
              placeholder="agent id（唯一）"
              value={agent.id}
              onChange={(e) => updateAgent(index, { id: e.target.value })}
              style={{ padding: '6px' }}
            />
            <input
              placeholder="appId"
              value={agent.appId}
              onChange={(e) => updateAgent(index, { appId: e.target.value })}
              style={{ padding: '6px' }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <input
              placeholder="appSecret"
              value={agent.appSecret}
              onChange={(e) => updateAgent(index, { appSecret: e.target.value })}
              style={{ padding: '6px' }}
            />
            <input
              placeholder="默认工作目录（可选，如 /work/a）"
              value={agent.cwd ?? ''}
              onChange={(e) => updateAgent(index, { cwd: e.target.value })}
              style={{ padding: '6px' }}
            />
          </div>
          <textarea
            placeholder="AGENTS.md 指令（写入该 agent 工作目录）"
            value={agent.agentsMd ?? ''}
            onChange={(e) => updateAgent(index, { agentsMd: e.target.value })}
            style={{ width: '100%', padding: '6px', minHeight: '48px', marginBottom: '8px', boxSizing: 'border-box' }}
          />
          <input
            placeholder="chats（逗号分隔：oc_... 或 p2p/group）"
            value={(agent.chats ?? []).join(', ')}
            onChange={(e) => updateAgent(index, {
              chats: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
            })}
            style={{ width: '100%', padding: '6px', marginBottom: '8px', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input
                type="checkbox"
                checked={agent.default === true}
                onChange={(e) => updateAgent(index, { default: e.target.checked })}
              />
              默认 agent
            </label>
            <button type="button" onClick={() => removeAgent(index)}>删除</button>
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button type="button" onClick={addAgent}>+ 添加 agent</button>
        <button type="button" onClick={save}>保存</button>
        {saved && <span style={{ color: 'green' }}>已保存（重启生效）</span>}
        {error && <span style={{ color: 'red' }}>{error}</span>}
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
