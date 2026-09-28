import { describe, expect, it } from 'vitest'
import { AgentBridge } from '../src/agent/bridge.ts'
import type { HarnessLarkConfig } from '../src/core/config-schema.ts'

/** Build a bridge whose only interesting dependency is the sessionPersistence service. */
function makeBridge(persistence: unknown) {
  const ctx = { get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined) }
  const config = { topicSeparateSession: false } as unknown as HarnessLarkConfig
  return new AgentBridge(ctx as never, { config, accountId: 'a1', client: () => ({}) as never })
}

type FreshIdBridge = { nextFreshSessionId(message: unknown, generation: number): Promise<unknown> }

const message = { chatId: 'oc_test' }

describe('nextFreshSessionId vs sessionPersistence API', () => {
  it('falls back to list() when the service has no listSnapshots() (dsh 0.1.x)', async () => {
    const calls: string[] = []
    const bridge = makeBridge({
      list: async () => {
        calls.push('list')
        return []
      },
    })

    const id = await (bridge as unknown as FreshIdBridge).nextFreshSessionId(message, 0)

    expect(String(id)).toBe('lark:a1:oc_test')
    expect(calls).toEqual(['list'])
  })

  it('bumps the generation when list() already contains the candidate', async () => {
    const bridge = makeBridge({ list: async () => [{ header: { id: 'lark:a1:oc_test:1' } }] })

    const id = await (bridge as unknown as FreshIdBridge).nextFreshSessionId(message, 1)

    expect(String(id)).toBe('lark:a1:oc_test:2')
  })

  it('still prefers listSnapshots() when the service provides it', async () => {
    const calls: string[] = []
    const bridge = makeBridge({
      listSnapshots: async () => {
        calls.push('listSnapshots')
        return []
      },
      list: async () => {
        calls.push('list')
        return []
      },
    })

    await (bridge as unknown as FreshIdBridge).nextFreshSessionId(message, 0)

    expect(calls).toEqual(['listSnapshots'])
  })

  it('treats a service with neither method as "no persisted sessions"', async () => {
    const bridge = makeBridge({})

    const id = await (bridge as unknown as FreshIdBridge).nextFreshSessionId(message, 0)

    expect(String(id)).toBe('lark:a1:oc_test')
  })
})
