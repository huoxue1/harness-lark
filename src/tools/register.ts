/**
 * Tool registration helper for harness-lark.
 *
 * Wraps dsh's `defineTool` with the account/client resolution harness-lark
 * needs: every Feishu tool executes against the plugin's Lark client.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { LarkClient } from '../core/lark-client.ts'

/** A tool definition bound to the plugin's Lark client at execution time. */
export interface LarkToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Resolve the Lark client (from the active bridge account). */
  resolveClient: () => LarkClient
  execute: (args: Record<string, unknown>, client: LarkClient) => Promise<unknown>
  timeoutMs?: number
}

/** Register a Feishu tool on the context's tool registry. */
export function registerLarkTool(ctx: Context, def: LarkToolDef): void {
  ctx.tools.register(defineTool({
    name: def.name,
    description: def.description,
    parameters: def.parameters as never,
    timeoutMs: def.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const client = def.resolveClient()
      return def.execute(args, client)
    },
  }))
}
