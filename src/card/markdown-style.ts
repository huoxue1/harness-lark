/**
 * Markdown style optimization for Feishu cards.
 *
 * Ported from openclaw-lark's markdown-style.ts (MIT, ByteDance Ltd.):
 * heading demotion, table spacing, code-block padding, blank-line
 * compression, and invalid image-key stripping.
 */

/** Optimize Markdown for Feishu card rendering. */
export function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    let r = _optimizeMarkdownStyle(text, cardVersion)
    r = stripInvalidImageKeys(r)
    return r
  } catch {
    return text
  }
}

function _optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  // 1. Extract code blocks behind placeholders.
  const MARK = '___CB_'
  const codeBlocks: string[] = []
  let r = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (m, prefix = '') => {
    const block = m.slice(String(prefix).length)
    return `${prefix}${MARK}${codeBlocks.push(block) - 1}___`
  })

  // 2. Demote headings: H1 -> H4, H2..H6 -> H5. Order matters — demote
  //    H2..H6 first so H1 (now H4) is not re-matched by the H2..H6 pass.
  const hasH1toH3 = /^#{1,3} /m.test(text)
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1')
    r = r.replace(/^# (.+)$/gm, '#### $1')
  }

  if (cardVersion >= 2) {
    // 3. Spacing between consecutive headings.
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2')
    // 4. Table spacing.
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2')
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1')
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (m, _table, offset) => {
      const after = r.slice(offset + m.length).replace(/^\n+/, '')
      if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return m
      return m + '\n<br>\n'
    })
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3')
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3')
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3')
    // 5. Restore code blocks with spacing.
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`)
    })
  } else {
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block)
    })
  }

  // 6. Compress excess blank lines.
  r = r.replace(/\n{3,}/g, '\n\n')
  return r
}

/** Matches complete markdown image syntax: `![alt](value)`. */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

/**
 * Strip `![alt](value)` where value is not a valid Feishu image key
 * (`img_xxx`). Prevents card errors on non-image URLs.
 */
function stripInvalidImageKeys(text: string): string {
  return text.replace(IMAGE_RE, (match, alt: string, value: string) => {
    if (value.startsWith('img_')) return match
    return alt ? alt : ''
  })
}
