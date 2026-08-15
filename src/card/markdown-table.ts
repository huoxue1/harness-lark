/**
 * Markdown table → Feishu card `table` component conversion.
 *
 * Feishu's Card JSON `markdown` element does NOT render standard Markdown
 * table syntax (`| col | col |`) — it shows the pipes as literal text. This
 * module detects complete Markdown table blocks (outside fenced code blocks)
 * and converts them to native Feishu `table` components, keeping the rest of
 * the content as `markdown` elements.
 *
 * Ported from openclaw's markdown-card.ts (MIT, ByteDance Ltd.):
 * https://github.com/openclaw/openclaw/pull/42809
 * Table element reference:
 * https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table
 */

/** One Feishu card element (markdown or table component). */
export type CardElement = { tag: string; [key: string]: unknown }

/** Max rows per Feishu table component (API limit is 1-10). */
const FEISHU_TABLE_PAGE_SIZE_MAX = 10

/** Fenced code block (``` ... ```) — table-shaped lines inside stay untouched. */
const FENCED_CODE_BLOCK_RE = /^[ \t]*`{3,}[\s\S]*?^[ \t]*`{3,}/gm

/** A complete Markdown table block: header row + separator row + data rows. */
const MD_TABLE_BLOCK_RE = new RegExp(
  '(?:^[ \\t]*\\|.+\\|[ \\t]*\\n)' + // header row
    '(?:^[ \\t]*\\|[\\s:|-]+\\|[ \\t]*\\n)' + // separator row
    '(?:^[ \\t]*\\|.+\\|[ \\t]*\\n?)+', // one or more data rows
  'gm',
)

/** Collect byte-ranges of all fenced code blocks, as sorted [start, end) spans. */
function collectCodeBlockSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  FENCED_CODE_BLOCK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCED_CODE_BLOCK_RE.exec(text)) !== null) {
    spans.push([match.index, match.index + match[0].length])
  }
  return spans
}

/** Whether `pos` falls inside any protected (fenced code block) span. */
function isInsideProtectedSpan(pos: number, spans: Array<[number, number]>): boolean {
  for (const [start, end] of spans) {
    if (pos >= start && pos < end) return true
    if (start > pos) break
  }
  return false
}

/** Parse one table row into cell values: `| a | b | c |` → `["a", "b", "c"]`. */
export function parseTableRow(line: string): string[] {
  let stripped = line.trim()
  if (stripped.startsWith('|')) stripped = stripped.slice(1)
  if (stripped.endsWith('|')) stripped = stripped.slice(0, -1)
  return stripped.split('|').map((cell) => cell.trim())
}

/** Convert a Markdown table string into a Feishu Card `table` element. */
export function mdTableToFeishuTable(tableText: string): CardElement | null {
  const lines = tableText.trim().split('\n').filter((l) => l.trim())
  // Need at least: header + separator + 1 data row.
  if (lines.length < 3) return null

  const headerLine = lines[0]!
  const dataLines = lines.slice(2)

  const headers = parseTableRow(headerLine)
  if (headers.length === 0) return null

  const columns = headers.map((header, i) => ({
    name: `col_${i}`,
    display_name: header,
    data_type: 'text',
    width: 'auto',
  }))

  const rows: Array<Record<string, string>> = []
  for (const dataLine of dataLines) {
    const cells = parseTableRow(dataLine)
    if (cells.length === 0) continue
    const row: Record<string, string> = {}
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]!.name] = i < cells.length ? cells[i]! : ''
    }
    rows.push(row)
  }

  if (rows.length === 0) return null

  return {
    tag: 'table',
    page_size: Math.min(rows.length, FEISHU_TABLE_PAGE_SIZE_MAX),
    row_height: 'low',
    header_style: {
      text_align: 'center',
      text_size: 'normal',
      background_style: 'grey',
      bold: true,
      lines: 1,
    },
    columns,
    rows,
  }
}

/**
 * Split text into alternating `markdown` elements and `table` components.
 * Table blocks are detected only outside fenced code blocks; surrounding
 * whitespace of each segment is preserved.
 */
export function splitTextAndTables(text: string): CardElement[] {
  const elements: CardElement[] = []
  const codeSpans = collectCodeBlockSpans(text)
  MD_TABLE_BLOCK_RE.lastIndex = 0

  let lastEnd = 0
  let match: RegExpExecArray | null
  while ((match = MD_TABLE_BLOCK_RE.exec(text)) !== null) {
    if (isInsideProtectedSpan(match.index, codeSpans)) continue

    const before = text.slice(lastEnd, match.index)
    if (before.trim()) elements.push({ tag: 'markdown', content: before })

    const tableElement = mdTableToFeishuTable(match[0])
    // Fallback: keep the raw table as markdown (loses the table layout but
    // never the data).
    elements.push(tableElement ?? { tag: 'markdown', content: match[0] })

    lastEnd = match.index + match[0].length
  }

  const after = text.slice(lastEnd)
  if (after.trim()) elements.push({ tag: 'markdown', content: after })

  if (elements.length === 0) elements.push({ tag: 'markdown', content: '' })
  return elements
}

/** Whether the text contains a complete Markdown table block. */
export function hasMarkdownTables(text: string): boolean {
  MD_TABLE_BLOCK_RE.lastIndex = 0
  return MD_TABLE_BLOCK_RE.test(text)
}
