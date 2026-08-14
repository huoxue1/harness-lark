import { describe, expect, it } from 'vitest'
import { buildBlocksFromMarkdown, renderBlocksToMarkdown } from '../src/tools/docx-render.ts'

describe('docx markdown conversion', () => {
  it('renders headings, text, lists, and code blocks', () => {
    const blocks = buildBlocksFromMarkdown('# Title\n\nhello\n\n- item\n\n```\ncode\n```')
    const markdown = renderBlocksToMarkdown(blocks as never)
    expect(markdown).toContain('Title')
    expect(markdown).toContain('hello')
    expect(markdown).toContain('item')
    expect(markdown).toContain('code')
  })

  it('builds heading blocks with the right level', () => {
    const blocks = buildBlocksFromMarkdown('## Sub')
    expect(blocks[0]).toMatchObject({ block_type: 3 })
  })

  it('converts block payloads back to markdown', () => {
    const blocks = [
      { block_type: 2, text: { elements: [{ text_run: { content: 'plain' } }] } },
      { block_type: 12, bullet: { elements: [{ text_run: { content: 'li' } }] } },
      { block_type: 15, quote: { elements: [{ text_run: { content: 'q' } }] } },
    ]
    const md = renderBlocksToMarkdown(blocks as never)
    expect(md).toContain('plain')
    expect(md).toContain('- li')
    expect(md).toContain('> q')
  })
})
