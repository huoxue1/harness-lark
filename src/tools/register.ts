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
  /** Tool result — the raw SDK response shape is version-drifted, so `unknown`. */
  execute: (args: Record<string, unknown>, client: LarkClient) => Promise<unknown>
  timeoutMs?: number
}

/** Register a Feishu tool on the context's tool registry. */
export function registerLarkTool(ctx: Context, def: LarkToolDef): void {
  ctx.tools.register(defineTool({
    name: def.name,
    description: def.description,
    parameters: def.parameters as never,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
      // Default render: JSON-stringify the tool result for the model.
      render: (_args, value) => [{ type: 'text', text: formatToolValue(value) }],
    },
    timeoutMs: def.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const client = def.resolveClient()
      // Tool results are dynamic JSON values assembled at runtime; the
      // executor validates them against the schema after execution.
      return (await def.execute(args, client)) as never
    },
  }))
}

/** Render a tool result value as model-visible text. */
function formatToolValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return 'ok'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
