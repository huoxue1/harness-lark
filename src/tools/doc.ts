/**
 * Feishu document tools: create_doc, fetch_doc, update_doc, wiki, drive.
 *
 * Implements the doc/Wiki/Drive capability family against the Feishu OAPI
 * directly (openclaw-lark delegates these to the Feishu MCP server; a dsh
 * plugin has no MCP runtime, so harness-lark calls the OAPI itself).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LarkClient } from '../core/lark-client.ts'
import type { ToolClient } from '../core/tool-client.ts'
import { registerLarkTool } from './register.ts'
import { renderBlocksToMarkdown, buildBlocksFromMarkdown } from './docx-render.ts'

/** Resolve a docx document token from a URL or token string. */
function extractDocToken(input: string): string {
  // Accept URLs like https://xxx.feishu.cn/docx/AbCdEf123 and bare tokens.
  const m = input.match(/(?:docx|wiki|base)\/([A-Za-z0-9]+)/)
  return m ? m[1]! : input.trim()
}

export function registerDocTools(ctx: Context, resolveClient: () => LarkClient): void {
  // feishu_create_doc — create a cloud doc from Markdown.
  registerLarkTool(ctx, {
    name: 'feishu_create_doc',
    description:
      'Create a Feishu cloud document from Markdown content. Returns the document token and URL. ' +
      'Optionally place it under a parent folder (folder_token) or wiki space.',
    parameters: {
      title: { type: 'string', required: true, description: 'Document title.' },
      markdown: { type: 'string', required: true, description: 'Markdown content of the document.' },
      folder_token: { type: 'string', description: 'Parent folder token (optional).' },
      wiki_space: { type: 'string', description: 'Wiki space id (optional, e.g. my_library).' },
    },
    resolveClient,
    async execute(args, _client, _exec, tc) {
      const title = String(args.title)
      const markdown = String(args.markdown)

      // Step 1: create an empty docx document (user identity when authorized).
      const created = await tc.invoke(async (sdk, opts) => {
        const resp = await sdk.docx.document.create({
          data: {
            title,
            folder_token: args.folder_token ? String(args.folder_token) : undefined,
          } as never,
        }, opts)
        return resp
      })
      const data = created.data as { document?: { document_id?: string; title?: string } } | undefined
      const documentId = data?.document?.document_id
      if (!documentId) throw new Error('create_doc: no document_id in response')

      // Step 2: write the Markdown as blocks.
      if (markdown.trim()) {
        await writeMarkdownBlocks(tc, documentId, markdown)
      }

      return {
        document_id: documentId,
        title: data?.document?.title ?? title,
        url: `https://feishu.cn/docx/${documentId}`,
      }
    },
  })

  // feishu_fetch_doc — read a docx document as Markdown.
  registerLarkTool(ctx, {
    name: 'feishu_fetch_doc',
    description:
      'Fetch the content of a Feishu cloud document (docx) and return it as Markdown. ' +
      'Accepts a document token or a full document URL. Reads with the authorizing user\'s identity when they have run /feishu auth, else with the app identity.',
    parameters: {
      doc_id: { type: 'string', required: true, description: 'Document id or URL.' },
      offset: { type: 'integer', description: 'Optional block offset for pagination (default 0).' },
      limit: { type: 'integer', description: 'Optional maximum number of blocks to return.' },
    },
    resolveClient,
    async execute(args, client, _exec, tc) {
      const docToken = extractDocToken(String(args.doc_id))
      const blocks = await tc.invoke(async (sdk, opts) => {
        const all: Array<Record<string, unknown>> = []
        let pageToken: string | undefined
        do {
          const response = await sdk.docx.documentBlock.list({
            path: { document_id: docToken },
            params: { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) } as never,
          }, opts)
          const data = response.data as
            | { items?: Array<Record<string, unknown>>; has_more?: boolean; page_token?: string }
            | undefined
          all.push(...(data?.items ?? []))
          pageToken = data?.has_more ? data?.page_token : undefined
        } while (pageToken)
        return all
      })
      const offset = typeof args.offset === 'number' ? args.offset : 0
      const limit = typeof args.limit === 'number' ? args.limit : blocks.length
      const slice = blocks.slice(offset, offset + limit)
      return {
        document_id: docToken,
        markdown: renderBlocksToMarkdown(slice),
        total_blocks: blocks.length,
      }
    },
  })

  // feishu_update_doc — append Markdown to an existing docx document.
  registerLarkTool(ctx, {
    name: 'feishu_update_doc',
    description: 'Append Markdown content to an existing Feishu cloud document (docx).',
    parameters: {
      doc_id: { type: 'string', required: true, description: 'Document id or URL.' },
      markdown: { type: 'string', required: true, description: 'Markdown content to append.' },
    },
    resolveClient,
    async execute(args, _client, _exec, tc) {
      const docToken = extractDocToken(String(args.doc_id))
      await writeMarkdownBlocks(tc, docToken, String(args.markdown))
      return { document_id: docToken, appended: true }
    },
  })

  // feishu_wiki_space_node — list wiki nodes.
  registerLarkTool(ctx, {
    name: 'feishu_wiki_space_node',
    description: 'List child wiki nodes of a Feishu wiki space or node.',
    parameters: {
      space_id: { type: 'string', required: true, description: 'Wiki space id.' },
      parent_node_token: { type: 'string', description: 'Parent node token; omit for the space root.' },
      page_size: { type: 'integer', description: 'Max results (default 20).' },
    },
    resolveClient,
    async execute(args, client) {
      const response = await client.client.wiki.spaceNode.list({
        params: {
          space_id: String(args.space_id),
          parent_node_token: args.parent_node_token ? String(args.parent_node_token) : undefined,
          page_size: typeof args.page_size === 'number' ? args.page_size : 20,
        } as never,
      })
      const items = ((response.data as { items?: unknown[] } | undefined)?.items ?? []) as Array<{
        node_token?: string
        title?: string
        obj_type?: string
        has_child?: boolean
      }>
      return {
        items: items.map((n) => ({
          node_token: n.node_token,
          title: n.title,
          obj_type: n.obj_type,
          has_child: n.has_child,
        })),
      }
    },
  })

  // feishu_drive_file — search or list drive files.
  registerLarkTool(ctx, {
    name: 'feishu_drive_file',
    description: 'Search Feishu Drive files by name, or list files in a folder.',
    parameters: {
      search: { type: 'string', description: 'Search query for file names.' },
      folder_token: { type: 'string', description: 'Folder token to list.' },
      page_size: { type: 'integer', description: 'Max results (default 20).' },
    },
    resolveClient,
    async execute(args, client) {
      if (args.search) {
        const response = await client.api.drive.file.search({
          data: {
            search_key: String(args.search),
            count: typeof args.page_size === 'number' ? args.page_size : 20,
          },
        })
        const files = (response.data as { files?: unknown[] } | undefined)?.files ?? []
        return { files }
      }
      if (args.folder_token) {
        const response = await client.api.drive.file.list({
          params: {
            folder_token: String(args.folder_token),
            page_size: typeof args.page_size === 'number' ? args.page_size : 20,
          },
        })
        const files = (response.data as { files?: unknown[] } | undefined)?.files ?? []
        return { files }
      }
      throw new Error('drive_file: provide either search or folder_token')
    },
  })
}

/** Write Markdown into a docx document by converting paragraphs to blocks. */
async function writeMarkdownBlocks(tc: ToolClient, documentId: string, markdown: string): Promise<void> {
  // Convert Markdown paragraphs into docx text blocks. A paragraph is a
  // text block; lines starting with "#" become heading blocks.
  const children = buildBlocksFromMarkdown(markdown)
  await tc.invoke(async (sdk, opts) => {
    await sdk.docx.documentBlockChildren.create({
      path: { document_id: documentId, block_id: documentId },
      data: { children } as never,
    }, opts)
  })
}
