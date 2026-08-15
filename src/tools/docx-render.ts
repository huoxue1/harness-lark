/**
 * docx block -> Markdown converter.
 *
 * openclaw-lark delegates doc rendering to the Feishu MCP server; harness-lark
 * calls the docx OAPI directly, so it needs its own block renderer. Supports
 * the common block types: text, headings, code, lists, quotes, tables, images,
 * callouts, and dividers. Unknown blocks render as their text children.
 */

interface DocxTextElement {
  text_run?: { content?: string; text_element_style?: { link?: { url?: string }; bold?: boolean; italic?: boolean } }
  mention_doc?: { title?: string }
  mention_user?: { user_id?: string }
  equation?: { content?: string }
  [key: string]: unknown
}

interface DocxBlock {
  block_id?: string
  block_type?: number
  text?: { elements?: DocxTextElement[]; style?: { heading_level?: number } }
  heading1?: { elements?: DocxTextElement[] }
  heading2?: { elements?: DocxTextElement[] }
  heading3?: { elements?: DocxTextElement[] }
  heading4?: { elements?: DocxTextElement[] }
  heading5?: { elements?: DocxTextElement[] }
  heading6?: { elements?: DocxTextElement[] }
  heading7?: { elements?: DocxTextElement[] }
  heading8?: { elements?: DocxTextElement[] }
  heading9?: { elements?: DocxTextElement[] }
  bullet?: { elements?: DocxTextElement[] }
  ordered?: { elements?: DocxTextElement[] }
  code?: { elements?: DocxTextElement[]; style?: { language?: number } }
  quote?: { elements?: DocxTextElement[] }
  todo?: { elements?: DocxTextElement[]; style?: { done?: boolean } }
  table?: { property?: { row_size?: number; column_size?: number }; table_cell?: DocxCell[] }
  image?: { image?: { token?: string } }
  callout?: { elements?: DocxTextElement[]; style?: { background_color?: unknown } }
  divider?: { divider?: unknown }
  file?: { file?: { token?: string; name?: string } }
  [key: string]: unknown
}

interface DocxCell {
  cell?: { children?: DocxBlock[] }
  [key: string]: unknown
}

function renderElements(elements?: DocxTextElement[]): string {
  if (!elements) return ''
  let out = ''
  for (const el of elements) {
    if (el.text_run) {
      let t = el.text_run.content ?? ''
      const style = el.text_run.text_element_style
      if (style?.link?.url) t = `[${t}](${style.link.url})`
      if (style?.bold) t = `**${t}**`
      if (style?.italic) t = `_${t}_`
      out += t
    } else if (el.mention_doc) {
      out += `📄 ${el.mention_doc.title ?? 'doc'}`
    } else if (el.mention_user) {
      out += `@${el.mention_user.user_id ?? 'user'}`
    } else if (el.equation) {
      out += `$${el.equation.content ?? ''}$`
    }
  }
  return out
}

/** Render a docx block list into Markdown. */
export function renderBlocksToMarkdown(blocks: DocxBlock[]): string {
  const lines: (string | null)[] = []
  for (const block of blocks) {
    lines.push(renderBlock(block))
  }
  return lines.filter((l): l is string => l !== null).join('\n')
}

function renderBlock(block: DocxBlock): string | null {
  const bt = block.block_type
  switch (bt) {
    case 2: // text
      return renderElements(block.text?.elements) || null
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 10:
    case 11: {
      const heading = block[`heading${bt - 2}` as keyof DocxBlock] as
        | { elements?: DocxTextElement[] }
        | undefined
      const level = Math.min(bt - 2, 6)
      const text = renderElements(heading?.elements)
      return text === '' ? null : `${'#'.repeat(level)} ${text}`
    }
    case 12: // bullet
      return nonEmpty(renderElements(block.bullet?.elements), (t) => `- ${t}`)
    case 13: // ordered
      return nonEmpty(renderElements(block.ordered?.elements), (t) => `1. ${t}`)
    case 14: // code
      return nonEmpty(renderElements(block.code?.elements), (t) => `\`\`\`\n${t}\n\`\`\``)
    case 15: // quote
      return nonEmpty(renderElements(block.quote?.elements), (t) => `> ${t}`)
    case 17: // todo
      return nonEmpty(renderElements(block.todo?.elements), (t) => `- [${block.todo?.style?.done ? 'x' : ' '}] ${t}`)
    case 31: {
      // table
      const table = block.table
      if (!table?.table_cell) return null
      const rows: string[][] = []
      for (const cell of table.table_cell) {
        const children = cell.cell?.children ?? []
        rows.push([renderBlocksToMarkdown(children).replace(/\n/g, ' ')])
      }
      const colCount = table.property?.column_size ?? 1
      const grid: string[][] = []
      for (let i = 0; i < rows.length; i += colCount) {
        grid.push(rows.slice(i, i + colCount).map((r) => r[0] ?? ''))
      }
      if (grid.length === 0) return null
      const header = grid[0] ?? []
      const sep = header.map(() => '---')
      const body = grid.slice(1)
      return [header.join(' | '), sep.join(' | '), ...body.map((r) => r.join(' | '))].join('\n')
    }
    case 27: // image
      return block.image?.image?.token ? `![image](img_${block.image.image.token})` : null
    case 21: // callout
      return nonEmpty(renderElements(block.callout?.elements), (t) => `> 💡 ${t}`)
    case 22: // divider
      return '---'
    case 26: // file
      return block.file?.file?.name ? `📎 ${block.file.file.name}` : null
    default:
      return renderUnknown(block)
  }
}

/** Return null when text is empty, else the wrapped rendering. */
function nonEmpty(text: string, wrap: (t: string) => string): string | null {
  return text === '' ? null : wrap(text)
}

function renderUnknown(block: DocxBlock): string | null {
  // Fall back to the first element list found on the block.
  for (const key of Object.keys(block)) {
    const value = block[key]
    if (value && typeof value === 'object') {
      const els = (value as { elements?: DocxTextElement[] }).elements
      const text = renderElements(els)
      if (text) return text
    }
  }
  return null
}

/** Convert Markdown lines into docx block payloads (headings + text). */
export function buildBlocksFromMarkdown(markdown: string): Array<Record<string, unknown>> {
  const children: Array<Record<string, unknown>> = []
  const lines = markdown.split('\n')

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1]!.length
      const tag = `heading${level}`
      children.push({
        block_type: 3,
        [tag]: { elements: [{ text_run: { content: heading[2] ?? '' } }] },
      })
      continue
    }

    if (line.startsWith('```')) {
      // Simple code fence: collect until the closing fence.
      const codeLines: string[] = []
      const rest = lines.slice(lines.indexOf(raw) + 1)
      for (const cl of rest) {
        if (cl.startsWith('```')) break
        codeLines.push(cl)
      }
      children.push({
        block_type: 14,
        code: { elements: [{ text_run: { content: codeLines.join('\n') } }] },
      })
      continue
    }

    if (line.startsWith('- ')) {
      children.push({
        block_type: 12,
        bullet: { elements: [{ text_run: { content: line.slice(2) } }] },
      })
      continue
    }

    if (line.startsWith('> ')) {
      children.push({
        block_type: 15,
        quote: { elements: [{ text_run: { content: line.slice(2) } }] },
      })
      continue
    }

    children.push({
      block_type: 2,
      text: { elements: [{ text_run: { content: line } }] },
    })
  }

  return children
}
