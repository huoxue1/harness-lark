import { describe, expect, it } from 'vitest'
import {
  hasMarkdownTables,
  mdTableToFeishuTable,
  parseTableRow,
  splitTextAndTables,
} from '../src/card/markdown-table.ts'
import { buildCompleteCard } from '../src/card/builder.ts'

describe('parseTableRow', () => {
  it('parses a standard table row with leading/trailing pipes', () => {
    expect(parseTableRow('| a | b | c |')).toEqual(['a', 'b', 'c'])
  })

  it('handles extra whitespace in cells', () => {
    expect(parseTableRow('|  foo  |  bar  |')).toEqual(['foo', 'bar'])
  })

  it('handles row without leading pipe', () => {
    expect(parseTableRow('a | b | c |')).toEqual(['a', 'b', 'c'])
  })

  it('handles row without trailing pipe', () => {
    expect(parseTableRow('| a | b | c')).toEqual(['a', 'b', 'c'])
  })
})

describe('mdTableToFeishuTable', () => {
  it('converts a basic 2-column table', () => {
    const table = ['| Name | Age |', '|------|-----|', '| Alice | 30 |', '| Bob | 25 |'].join('\n')
    const result = mdTableToFeishuTable(table)
    expect(result).not.toBeNull()
    expect(result!.tag).toBe('table')
    expect(result!.page_size).toBe(2)
    const columns = result!.columns as Array<{ name: string; display_name: string }>
    expect(columns[0]!.display_name).toBe('Name')
    expect(columns[1]!.display_name).toBe('Age')
    const rows = result!.rows as Array<Record<string, string>>
    expect(rows[0]!.col_0).toBe('Alice')
    expect(rows[0]!.col_1).toBe('30')
    expect(rows[1]!.col_0).toBe('Bob')
  })

  it('returns null for text with fewer than 3 lines', () => {
    expect(mdTableToFeishuTable('| a |\n|---|')).toBeNull()
  })

  it('fills missing cells with empty strings', () => {
    const table = ['| A | B | C |', '|---|---|---|', '| x |'].join('\n')
    const result = mdTableToFeishuTable(table)
    expect(result).not.toBeNull()
    const rows = result!.rows as Array<Record<string, string>>
    expect(rows[0]!.col_0).toBe('x')
    expect(rows[0]!.col_1).toBe('')
    expect(rows[0]!.col_2).toBe('')
  })

  it('sets a grey bold centered header_style', () => {
    const table = ['| H1 | H2 |', '|----|----|', '| v1 | v2 |'].join('\n')
    const result = mdTableToFeishuTable(table)
    expect(result).not.toBeNull()
    const style = result!.header_style as Record<string, unknown>
    expect(style.background_style).toBe('grey')
    expect(style.bold).toBe(true)
    expect(style.text_align).toBe('center')
  })

  it('caps page_size at 10 for large tables', () => {
    const rows = Array.from({ length: 15 }, (_, i) => `| r${i} | v${i} |`)
    const table = ['| A | B |', '|---|---|', ...rows].join('\n')
    const result = mdTableToFeishuTable(table)
    expect(result).not.toBeNull()
    expect(result!.page_size).toBe(10)
    expect((result!.rows as unknown[]).length).toBe(15)
  })
})

describe('splitTextAndTables', () => {
  it('returns a single markdown element for text without tables', () => {
    expect(splitTextAndTables('Hello **world**')).toEqual([{ tag: 'markdown', content: 'Hello **world**' }])
  })

  it('returns an empty markdown element for empty text', () => {
    expect(splitTextAndTables('')).toEqual([{ tag: 'markdown', content: '' }])
  })

  it('converts a standalone table to a table component', () => {
    const result = splitTextAndTables('| A | B |\n|---|---|\n| 1 | 2 |\n')
    expect(result).toHaveLength(1)
    expect(result[0]!.tag).toBe('table')
  })

  it('splits text + table + text into 3 elements', () => {
    const text = [
      'Here is a summary:',
      '',
      '| Name | Score |',
      '|------|-------|',
      '| Alice | 95 |',
      '| Bob | 87 |',
      '',
      "That's all!",
    ].join('\n')
    const result = splitTextAndTables(text)
    expect(result).toHaveLength(3)
    expect(result[0]!.tag).toBe('markdown')
    expect((result[0]!.content as string).trim()).toBe('Here is a summary:')
    expect(result[1]!.tag).toBe('table')
    expect(result[2]!.tag).toBe('markdown')
    expect((result[2]!.content as string).trim()).toBe("That's all!")
  })

  it('does NOT convert tables inside fenced code blocks', () => {
    const text = ['Example table syntax:', '', '```md', '| A | B |', '|---|---|', '| 1 | 2 |', '```', '', 'End.'].join('\n')
    const result = splitTextAndTables(text)
    expect(result).toHaveLength(1)
    expect(result[0]!.tag).toBe('markdown')
    expect(result[0]!.content as string).toContain('| A | B |')
  })

  it('converts a real table but preserves the code block', () => {
    const text = [
      'Here is example code:',
      '',
      '```',
      '| X | Y |',
      '|---|---|',
      '| a | b |',
      '```',
      '',
      'And here is a real table:',
      '',
      '| Name | Score |',
      '|------|-------|',
      '| Alice | 95 |',
    ].join('\n')
    const result = splitTextAndTables(text)
    const tables = result.filter((e) => e.tag === 'table')
    const markdown = result.filter((e) => e.tag === 'markdown')
    expect(tables).toHaveLength(1)
    expect(markdown.some((e) => (e.content as string).includes('```'))).toBe(true)
  })

  it('handles multiple tables in one text', () => {
    const text = [
      'Table 1:',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Table 2:',
      '| C | D |',
      '|---|---|',
      '| 3 | 4 |',
    ].join('\n')
    const result = splitTextAndTables(text)
    expect(result.filter((e) => e.tag === 'table')).toHaveLength(2)
  })
})

describe('hasMarkdownTables', () => {
  it('returns true when text contains a table', () => {
    expect(hasMarkdownTables('| A | B |\n|---|---|\n| 1 | 2 |\n')).toBe(true)
  })

  it('returns false for text without tables', () => {
    expect(hasMarkdownTables('Hello world\n\nNo tables here')).toBe(false)
  })

  it('returns false for pipe characters that are not tables', () => {
    expect(hasMarkdownTables('a | b but not a table')).toBe(false)
  })
})

describe('buildCompleteCard with tables', () => {
  it('converts answer markdown tables to native table elements', () => {
    const text = ['Results:', '', '| Test | Status |', '|------|--------|', '| Unit | Pass |', '', 'Done.'].join('\n')
    const card = buildCompleteCard({ text })
    const tables = card.elements.filter((e) => e.tag === 'table')
    const markdowns = card.elements.filter((e) => e.tag === 'markdown')
    expect(tables).toHaveLength(1)
    expect((tables[0]!.columns as Array<{ display_name: string }>)[0]!.display_name).toBe('Test')
    expect(markdowns.length).toBeGreaterThan(0)
  })

  it('keeps plain markdown as a single element', () => {
    const card = buildCompleteCard({ text: '**Bold** and `code`' })
    expect(card.elements.filter((e) => e.tag === 'table')).toHaveLength(0)
  })
})
