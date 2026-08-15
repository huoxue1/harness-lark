/**
 * Tool family registration index for harness-lark.
 *
 * Exports the three tool-family registers: docs/Wiki/Drive, Base/Sheets/
 * Calendar/Task, and user OAuth.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LarkClient } from '../core/lark-client.ts'
import { registerDocTools } from './doc.ts'
import { registerBaseSheetsCalendarTaskTools } from './base-sheets-calendar-task.ts'
import { registerOAuthTool } from './oauth.ts'
import { registerMediaTools } from './media.ts'

/** Register every Feishu tool family on the context. */
export function registerFeishuTools(ctx: Context, resolveClient: () => LarkClient): void {
  registerDocTools(ctx, resolveClient)
  registerBaseSheetsCalendarTaskTools(ctx, resolveClient)
  registerOAuthTool(ctx, resolveClient)
  registerMediaTools(ctx, resolveClient)
}

export { registerDocTools } from './doc.ts'
export { registerBaseSheetsCalendarTaskTools } from './base-sheets-calendar-task.ts'
export { registerOAuthTool } from './oauth.ts'
export { registerMediaTools } from './media.ts'
export { registerLarkTool } from './register.ts'
export { renderBlocksToMarkdown, buildBlocksFromMarkdown } from './docx-render.ts'
