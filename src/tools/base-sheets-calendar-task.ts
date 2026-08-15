/**
 * Feishu Base (Bitable), Sheets, Calendar, and Task tools.
 *
 * Implements the Base/表格/日历/任务 capability family against the Feishu
 * OAPI directly, following the openclaw-lark tool contracts.
 *
 * All tools call the SDK through `ToolClient`, so a request that runs inside
 * a message turn uses the authorizing user's identity when they have run
 * `/feishu auth`, falling back to the app identity otherwise.
 *
 * Notes on the two endpoints the SDK does not type:
 * - Listing bitable apps goes through the Drive file API (`drive.file.list`)
 *   filtered to `type === 'bitable'`; the Bitable API has no "list apps"
 *   endpoint.
 * - Reading/writing sheet cell values goes through the raw sheets v2 values
 *   API (`ToolClient.invokeRaw`); the SDK's `spreadsheetSheet.get` returns
 *   sheet metadata, not cell values, and has no range-write method.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LarkClient } from '../core/lark-client.ts'
import type { ToolClient } from '../core/tool-client.ts'
import { registerLarkTool } from './register.ts'

export function registerBaseSheetsCalendarTaskTools(
  ctx: Context,
  resolveClient: () => LarkClient,
): void {
  // ── Bitable ────────────────────────────────────────────────────────────

  registerLarkTool(ctx, {
    name: 'feishu_bitable_app',
    description:
      'List Feishu Bitable (multi-dimensional table) apps in a folder. ' +
      'Lists Drive files filtered to the bitable type (the Bitable API has no list-apps endpoint).',
    parameters: {
      folder_token: { type: 'string', description: 'Folder token (default: my space root).' },
      page_size: { type: 'integer', description: 'Max results (default 50, max 200).' },
      page_token: { type: 'string', description: 'Pagination token.' },
    },
    resolveClient,
    async execute(args, _client, _exec, tc) {
      const params: Record<string, unknown> = {
        page_size: typeof args.page_size === 'number' ? args.page_size : 50,
      }
      if (args.folder_token) params.folder_token = String(args.folder_token)
      if (args.page_token) params.page_token = String(args.page_token)

      const response = await tc.invokeApi(async (api, opts) => api.drive.file.list({
        params: params as never,
      }, opts))
      const data = response.data as {
        files?: Array<{ token?: string; name?: string; type?: string; url?: string }>
        has_more?: boolean
        next_page_token?: string
      } | undefined
      const apps = (data?.files ?? [])
        .filter((f) => f.type === 'bitable')
        .map((f) => ({
          ...(f.token !== undefined ? { token: f.token } : {}),
          ...(f.name !== undefined ? { name: f.name } : {}),
          ...(f.type !== undefined ? { type: f.type } : {}),
          ...(f.url !== undefined ? { url: f.url } : {}),
        }))
      return {
        apps,
        has_more: data?.has_more ?? false,
        ...(data?.next_page_token !== undefined ? { page_token: data.next_page_token } : {}),
      }
    },
  })

  registerLarkTool(ctx, {
    name: 'feishu_bitable_app_table',
    description: 'List tables of a Feishu Bitable app.',
    parameters: {
      app_token: { type: 'string', required: true, description: 'Bitable app token.' },
      page_size: { type: 'integer', description: 'Max results (default 100).' },
    },
    resolveClient,
    async execute(args, _client, _exec, tc) {
      const response = await tc.invokeApi(async (api, opts) => api.bitable.appTable.list({
        path: { app_token: String(args.app_token) },
        params: { page_size: typeof args.page_size === 'number' ? args.page_size : 100 } as never,
      }, opts))
      return { items: (response.data as { items?: unknown[] } | undefined)?.items ?? [] }
    },
  })

  registerLarkTool(ctx, {
    name: 'feishu_bitable_app_table_record',
    description:
      'Create, query, update, or delete records in a Feishu Bitable table. ' +
      'Set action to create / list / get / update / delete.',
    parameters: {
      app_token: { type: 'string', required: true, description: 'Bitable app token.' },
      table_id: { type: 'string', required: true, description: 'Table id.' },
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'list', 'get', 'update', 'delete'],
        description: 'Operation to perform.',
      },
      fields: { type: 'object', additionalProperties: true, description: 'Record fields (for create/update).' },
      record_id: { type: 'string', description: 'Record id (for get/update/delete).' },
      page_size: { type: 'integer', description: 'Max results for list (default 20).' },
      filter: { type: 'string', description: 'Filter formula for list (e.g. CurrentValue.[field]="x").' },
    },
    resolveClient,
    async execute(args, _client, _exec, tc) {
      const appToken = String(args.app_token)
      const tableId = String(args.table_id)
      const action = String(args.action)
      const recordId = args.record_id ? String(args.record_id) : undefined

      switch (action) {
        case 'create': {
          const response = await tc.invokeApi(async (api, opts) => api.bitable.appTableRecord.create({
            path: { app_token: appToken, table_id: tableId },
            data: { fields: (args.fields as Record<string, unknown>) ?? {} } as never,
          }, opts))
          return { record: (response.data as { record?: unknown } | undefined)?.record ?? {} }
        }
        case 'list': {
          const response = await tc.invokeApi(async (api, opts) => api.bitable.appTableRecord.list({
            path: { app_token: appToken, table_id: tableId },
            params: {
              page_size: typeof args.page_size === 'number' ? args.page_size : 20,
              filter: args.filter ? String(args.filter) : undefined,
            } as never,
          }, opts))
          return { items: (response.data as { items?: unknown[] } | undefined)?.items ?? [] }
        }
        case 'get': {
          if (!recordId) throw new Error('record: get requires record_id')
          const response = await tc.invokeApi(async (api, opts) => api.bitable.appTableRecord.get({
            path: { app_token: appToken, table_id: tableId, record_id: recordId },
          }, opts))
          return { record: (response.data as { record?: unknown } | undefined)?.record ?? {} }
        }
        case 'update': {
          if (!recordId) throw new Error('record: update requires record_id')
          const response = await tc.invokeApi(async (api, opts) => api.bitable.appTableRecord.update({
            path: { app_token: appToken, table_id: tableId, record_id: recordId },
            data: { fields: (args.fields as Record<string, unknown>) ?? {} } as never,
          }, opts))
          return { record: (response.data as { record?: unknown } | undefined)?.record ?? {} }
        }
        case 'delete': {
          if (!recordId) throw new Error('record: delete requires record_id')
          const response = await tc.invokeApi(async (api, opts) => api.bitable.appTableRecord.delete({
            path: { app_token: appToken, table_id: tableId, record_id: recordId },
          }, opts))
          return { deleted: true, ...(response.data !== undefined ? { response: response.data } : {}) }
        }
        default:
          throw new Error(`record: unknown action "${action}"`)
      }
    },
  })

  registerLarkTool(ctx, {
    name: 'feishu_bitable_app_table_field',
    description: 'List fields (columns) of a Feishu Bitable table.',
    parameters: {
      app_token: { type: 'string', required: true, description: 'Bitable app token.' },
      table_id: { type: 'string', required: true, description: 'Table id.' },
    },
    resolveClient,
    async execute(args, _client, _exec, tc) {
      const response = await tc.invokeApi(async (api, opts) => api.bitable.appTableField.list({
        path: { app_token: String(args.app_token), table_id: String(args.table_id) },
      }, opts))
      return { items: (response.data as { items?: unknown[] } | undefined)?.items ?? [] }
    },
  })

  registerLarkTool(ctx, {
    name: 'feishu_bitable_app_table_view',
    description: 'List views of a Feishu Bitable table.',
    parameters: {
      app_token: { type: 'string', required: true, description: 'Bitable app token.' },
      table_id: { type: 'string', required: true, description: 'Table id.' },
    },
    resolveClient,
    async execute(args, _client, _exec, tc) {
      const response = await tc.invokeApi(async (api, opts) => api.bitable.appTableView.list({
        path: { app_token: String(args.app_token), table_id: String(args.table_id) },
      }, opts))
      return { items: (response.data as { items?: unknown[] } | undefined)?.items ?? [] }
    },
  })

  // ── Sheets ─────────────────────────────────────────────────────────────

  registerLarkTool(ctx, {
    name: 'feishu_sheet',
    description:
      'Create, read, or write a Feishu spreadsheet. Set action to create / read / write. ' +
      'read/write use the sheets v2 values API; range like "A1:C10" (the first worksheet is resolved automatically, ' +
      'or include a sheet id prefix like "sheetId!A1:C10").',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'read', 'write'],
        description: 'Operation to perform.',
      },
      spreadsheet_token: { type: 'string', description: 'Spreadsheet token (for read/write).' },
      title: { type: 'string', description: 'Spreadsheet title (for create).' },
      range: { type: 'string', description: 'Cell range, e.g. A1:C10 (for read/write).' },
      values: { type: 'array', items: { type: 'array', items: { type: 'json' } }, description: '2D array of values (for write).' },
    },
    resolveClient,
    async execute(args, _client, _exec, tc) {
      const action = String(args.action)
      switch (action) {
        case 'create': {
          const response = await tc.invokeApi(async (api, opts) => api.sheets.spreadsheet.create({
            data: { title: args.title ? String(args.title) : 'New Sheet' } as never,
          }, opts))
          const spreadsheet = (response.data as { spreadsheet?: { spreadsheet_token?: string; url?: string } } | undefined)
            ?.spreadsheet
          return {
            ...(spreadsheet?.spreadsheet_token !== undefined ? { spreadsheet_token: spreadsheet.spreadsheet_token } : {}),
            ...(spreadsheet?.url !== undefined ? { url: spreadsheet.url } : {}),
          }
        }
        case 'read': {
          if (!args.spreadsheet_token || !args.range) {
            throw new Error('sheet: read requires spreadsheet_token and range')
          }
          const values = await readSheetRange(tc, String(args.spreadsheet_token), String(args.range))
          return { values }
        }
        case 'write': {
          if (!args.spreadsheet_token || !args.range || !Array.isArray(args.values)) {
            throw new Error('sheet: write requires spreadsheet_token, range, and values')
          }
          await writeSheetRange(tc, String(args.spreadsheet_token), String(args.range), args.values)
          return { written: true }
        }
        default:
          throw new Error(`sheet: unknown action "${action}"`)
      }
    },
  })

  // ── Calendar ───────────────────────────────────────────────────────────

  registerLarkTool(ctx, {
    name: 'feishu_calendar_event',
    description:
      'Create, list, get, update, or delete a Feishu calendar event. ' +
      'Set action to create / list / get / update / delete.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'list', 'get', 'update', 'delete'],
        description: 'Operation to perform.',
      },
      calendar_id: { type: 'string', description: 'Calendar id (default: the primary calendar).' },
      event_id: { type: 'string', description: 'Event id (for get/update/delete).' },
      summary: { type: 'string', description: 'Event title (for create/update).' },
      description: { type: 'string', description: 'Event description (for create/update).' },
      start_time: { type: 'string', description: 'Start timestamp in ms (for create/update).' },
      end_time: { type: 'string', description: 'End timestamp in ms (for create/update).' },
      page_size: { type: 'integer', description: 'Max results for list (default 20).' },
    },
    resolveClient,
    async execute(args, _client, _exec, tc) {
      const action = String(args.action)
      const calendarId = args.calendar_id ? String(args.calendar_id) : undefined
      const eventId = args.event_id ? String(args.event_id) : undefined
      const path = {
        calendar_id: calendarId ?? 'primary',
        ...(eventId ? { event_id: eventId } : {}),
      }

      switch (action) {
        case 'create': {
          if (!args.summary || !args.start_time || !args.end_time) {
            throw new Error('event: create requires summary, start_time, and end_time')
          }
          const response = await tc.invokeApi(async (api, opts) => api.calendar.calendarEvent.create({
            path,
            data: {
              summary: String(args.summary),
              description: args.description ? String(args.description) : undefined,
              start_time: { timestamp: String(args.start_time) },
              end_time: { timestamp: String(args.end_time) },
            } as never,
          }, opts))
          return { event: (response.data as { event?: unknown } | undefined)?.event ?? {} }
        }
        case 'list': {
          const response = await tc.invokeApi(async (api, opts) => api.calendar.calendarEvent.list({
            path: { calendar_id: calendarId ?? 'primary' },
            params: { page_size: typeof args.page_size === 'number' ? args.page_size : 20 } as never,
          }, opts))
          return { items: (response.data as { items?: unknown[] } | undefined)?.items ?? [] }
        }
        case 'get': {
          if (!eventId) throw new Error('event: get requires event_id')
          const response = await tc.invokeApi(async (api, opts) => api.calendar.calendarEvent.get({ path }, opts))
          return { event: (response.data as { event?: unknown } | undefined)?.event ?? {} }
        }
        case 'update': {
          if (!eventId) throw new Error('event: update requires event_id')
          const response = await tc.invokeApi(async (api, opts) => api.calendar.calendarEvent.patch({
            path,
            data: {
              summary: args.summary ? String(args.summary) : undefined,
              description: args.description ? String(args.description) : undefined,
              start_time: args.start_time ? { timestamp: String(args.start_time) } : undefined,
              end_time: args.end_time ? { timestamp: String(args.end_time) } : undefined,
            } as never,
          }, opts))
          return { event: (response.data as { event?: unknown } | undefined)?.event ?? {} }
        }
        case 'delete': {
          if (!eventId) throw new Error('event: delete requires event_id')
          await tc.invokeApi(async (api, opts) => api.calendar.calendarEvent.delete({ path }, opts))
          return { deleted: true }
        }
        default:
          throw new Error(`event: unknown action "${action}"`)
      }
    },
  })

  // ── Task ───────────────────────────────────────────────────────────────

  registerLarkTool(ctx, {
    name: 'feishu_task_task',
    description:
      'Create, list, get, update, or complete a Feishu task. ' +
      'Set action to create / list / get / update / complete.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'list', 'get', 'update', 'complete'],
        description: 'Operation to perform.',
      },
      task_id: { type: 'string', description: 'Task id (for get/update/complete).' },
      summary: { type: 'string', description: 'Task title (for create/update).' },
      description: { type: 'string', description: 'Task description (for create/update).' },
      due_time: { type: 'string', description: 'Due timestamp in ms (for create/update).' },
      completed: { type: 'boolean', description: 'Whether the task is complete (for update).' },
    },
    resolveClient,
    async execute(args, _client, _exec, tc) {
      const action = String(args.action)
      const taskId = args.task_id ? String(args.task_id) : undefined

      switch (action) {
        case 'create': {
          if (!args.summary) throw new Error('task: create requires summary')
          const response = await tc.invokeApi(async (api, opts) => api.task.task.create({
            data: {
              summary: String(args.summary),
              description: args.description ? String(args.description) : undefined,
              due: args.due_time ? { timestamp: String(args.due_time) } : undefined,
            } as never,
          }, opts))
          return { task: (response.data as { task?: unknown } | undefined)?.task ?? {} }
        }
        case 'list': {
          const response = await tc.invokeApi(async (api, opts) => api.task.task.list({ data: {} as never }, opts))
          return { items: (response.data as { items?: unknown[] } | undefined)?.items ?? [] }
        }
        case 'get': {
          if (!taskId) throw new Error('task: get requires task_id')
          const response = await tc.invokeApi(async (api, opts) => api.task.task.get({ path: { task_id: taskId } }, opts))
          return { task: (response.data as { task?: unknown } | undefined)?.task ?? {} }
        }
        case 'update': {
          if (!taskId) throw new Error('task: update requires task_id')
          const response = await tc.invokeApi(async (api, opts) => api.task.task.patch({
            path: { task_id: taskId },
            data: {
              summary: args.summary ? String(args.summary) : undefined,
              description: args.description ? String(args.description) : undefined,
              due: args.due_time ? { timestamp: String(args.due_time) } : undefined,
              completed_at: args.completed === true ? String(Date.now()) : undefined,
            } as never,
          }, opts))
          return { task: (response.data as { task?: unknown } | undefined)?.task ?? {} }
        }
        case 'complete': {
          if (!taskId) throw new Error('task: complete requires task_id')
          const response = await tc.invokeApi(async (api, opts) => api.task.task.patch({
            path: { task_id: taskId },
            data: { completed_at: String(Date.now()) } as never,
          }, opts))
          const task = (response.data as { task?: unknown } | undefined)?.task
          return { completed: true, ...(task !== undefined ? { task } : {}) }
        }
        default:
          throw new Error(`task: unknown action "${action}"`)
      }
    },
  })
}

/** Resolve the first worksheet id of a spreadsheet (for range auto-prefix). */
async function resolveFirstSheetId(tc: ToolClient, token: string): Promise<string | undefined> {
  const response = await tc.invokeApi(async (api, opts) => api.sheets.spreadsheetSheet.query({
    path: { spreadsheet_token: token },
  } as never, opts))
  const data = response.data as { sheets?: Array<{ sheet_id?: string }> } | undefined
  return data?.sheets?.[0]?.sheet_id
}

/** Read a sheet range as a 2D array of values (sheets v2 values API). */
async function readSheetRange(tc: ToolClient, token: string, range: string): Promise<unknown[][]> {
  const sheetId = await resolveFirstSheetId(tc, token)
  if (!sheetId) return []
  const fullRange = range.includes('!') ? range : `${sheetId}!${range}`
  const response = await tc.invokeRaw<{
    code?: number
    msg?: string
    data?: { valueRange?: { values?: unknown[][] } }
  }>({
    method: 'GET',
    url: `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(fullRange)}`,
    params: { valueRenderOption: 'ToString', dateTimeRenderOption: 'FormattedString' },
  })
  if (response.code && response.code !== 0) {
    throw new Error(`sheet read failed: ${response.msg ?? `code ${response.code}`}`)
  }
  return response.data?.valueRange?.values ?? []
}

/** Write a 2D array of values into a sheet range (sheets v2 values API). */
async function writeSheetRange(tc: ToolClient, token: string, range: string, values: unknown[]): Promise<void> {
  const sheetId = await resolveFirstSheetId(tc, token)
  if (!sheetId) throw new Error('sheet: no sheet found in spreadsheet')
  const fullRange = range.includes('!') ? range : `${sheetId}!${range}`
  const response = await tc.invokeRaw<{ code?: number; msg?: string }>({
    method: 'PUT',
    url: `/open-apis/sheets/v2/spreadsheets/${token}/values`,
    data: { valueRange: { range: fullRange, values } },
  })
  if (response.code && response.code !== 0) {
    throw new Error(`sheet write failed: ${response.msg ?? `code ${response.code}`}`)
  }
}
