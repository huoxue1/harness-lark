/**
 * User-level OAuth scopes harness-lark requests during /feishu auth.
 *
 * These scopes let the agent act on the authorizing user's behalf. Kept as a
 * single aggregate so a user authorizes once for every supported capability.
 *
 * Scope names follow the Feishu developer-console catalog (validated against
 * the device authorization endpoint; invalid names make the flow fail with
 * error 20043 "invalid_scope"). The bitable prefix is `base:*`, not `bitable:*`.
 */

/** Scopes for reading/writing user documents and data. */
export const USER_SCOPES = [
  // Documents (docx)
  'docx:document:readonly',
  'docx:document:write_only',
  'docx:document:create',
  // Wiki
  'wiki:node:read',
  'wiki:node:create',
  'wiki:node:retrieve',
  'wiki:space:read',
  'wiki:space:retrieve',
  'wiki:space:write_only',
  // Drive
  'drive:drive.metadata:readonly',
  'space:document:retrieve',
  'space:document:move',
  'drive:file:upload',
  'drive:file:download',
  // Bitable (base)
  'base:app:read',
  'base:app:create',
  'base:app:update',
  'base:table:read',
  'base:table:create',
  'base:record:retrieve',
  'base:record:create',
  'base:record:update',
  'base:record:delete',
  'base:field:read',
  'base:field:create',
  'base:view:read',
  'base:view:write_only',
  // Sheets
  'sheets:spreadsheet:read',
  'sheets:spreadsheet:write_only',
  'sheets:spreadsheet:create',
  'sheets:spreadsheet.meta:read',
  // Calendar
  'calendar:calendar:read',
  'calendar:calendar.event:read',
  'calendar:calendar.event:create',
  'calendar:calendar.event:update',
  'calendar:calendar.event:delete',
  // Task
  'task:task:read',
  'task:task:write',
  'task:task:writeonly',
] as const

/** Space-joined scope string for the device authorization request. */
export const USER_SCOPE_STRING = USER_SCOPES.join(' ')
