/**
 * Feishu media tools: download message attachments and send images/files.
 *
 * Download (`feishu_download_file`) reads file/image/audio content that
 * arrives as attachment messages. Send (`feishu_send_image`, `feishu_send_file`)
 * uploads a local path or URL and delivers it into the current chat.
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { LarkClient } from '../core/lark-client.ts'
import {
  downloadMessageResource,
  sendFile as sendFileLark,
  sendImage as sendImageLark,
  uploadFile,
  uploadImage,
  type FeishuFileType,
} from '../messaging/outbound/media.ts'
import { registerLarkTool } from './register.ts'

/**
 * Recover the Feishu chat id from the calling agent's session id.
 * Session ids are `lark:<accountId>:<chatId>` optionally suffixed by
 * `:thread:<threadId>` and `:<generation>`.
 */
function chatIdFromExec(exec: ToolRunContext): string | undefined {
  const id = exec.agent?.session.header.id
  if (!id) return undefined
  // lark:default:oc_xxx[:thread:omt_xxx][:N]
  const parts = id.split(':')
  // parts[0]=lark, parts[1]=accountId, parts[2]=chatId, then optional extras.
  return parts[2]
}

export function registerMediaTools(ctx: Context, resolveClient: () => LarkClient): void {
  registerLarkTool(ctx, {
    name: 'feishu_download_file',
    description:
      'Download the content of a file/image/audio attachment from a Feishu message. ' +
      'Returns the file name and its text content (for text files) or a size/type summary (for binary files). ' +
      'Use this when a message carries a file_key / image_key to read what the user attached.',
    parameters: {
      message_id: { type: 'string', required: true, description: 'The message id (om_xxx) that carries the attachment.' },
      file_key: { type: 'string', required: true, description: 'The file_key (file_xxx) or image_key (img_xxx).' },
      type: {
        type: 'string',
        required: true,
        enum: ['file', 'image'],
        description: 'Resource type: file or image.',
      },
    },
    resolveClient,
    async execute(args, client) {
      const messageId = String(args.message_id)
      const fileKey = String(args.file_key)
      const type = args.type === 'image' ? 'image' : 'file'

      const { buffer, fileName } = await downloadMessageResource(
        client.client,
        messageId,
        fileKey,
        type,
      )

      return {
        file_name: fileName ?? '(unnamed)',
        size_bytes: buffer.length,
        content: bufferToString(buffer),
      }
    },
  })

  registerLarkTool(ctx, {
    name: 'feishu_send_image',
    description:
      'Upload and send an image into the current Feishu chat. Accepts a local file path (the agent has filesystem access) or a public URL. Returns the sent message id.',
    parameters: {
      path_or_url: { type: 'string', required: true, description: 'Local file path or public URL of the image.' },
    },
    resolveClient,
    async execute(args, client, exec) {
      const chatId = chatIdFromExec(exec)
      const source = String(args.path_or_url)
      const image = await resolveMediaSource(source)
      const { imageKey } = await uploadImage(client.client, image)
      if (!chatId) {
        return { image_key: imageKey, uploaded: true, note: 'image uploaded; no chat id in scope to deliver into' }
      }
      const result = await sendImageLark(client.client, chatId, imageKey, 'chat_id')
      return { ok: result.ok, message_id: result.messageId, image_key: imageKey }
    },
  })

  registerLarkTool(ctx, {
    name: 'feishu_send_file',
    description:
      'Upload and send a file into the current Feishu chat. Accepts a local file path (the agent has filesystem access) or a public URL. Returns the sent message id.',
    parameters: {
      path_or_url: { type: 'string', required: true, description: 'Local file path or public URL of the file.' },
      file_name: { type: 'string', description: 'Display name of the file (defaults to the path basename).' },
    },
    resolveClient,
    async execute(args, client, exec) {
      const chatId = chatIdFromExec(exec)
      const source = String(args.path_or_url)
      const { buffer, fileName } = await resolveFileSource(source)
      const name = args.file_name ? String(args.file_name) : fileName
      const { fileKey } = await uploadFile(client.client, buffer, name, guessFileType(name))
      if (!chatId) {
        return { file_key: fileKey, uploaded: true, note: 'file uploaded; no chat id in scope to deliver into' }
      }
      const result = await sendFileLark(client.client, chatId, fileKey, 'chat_id')
      return { ok: result.ok, message_id: result.messageId, file_key: fileKey }
    },
  })
}

/** Best-effort UTF-8 decode with a size cap; binary content falls back to a summary. */
function bufferToString(buffer: Buffer): string {
  const MAX_BYTES = 256 * 1024
  const slice = buffer.subarray(0, MAX_BYTES)
  const decoded = slice.toString('utf8')
  const replacementRatio = (decoded.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, decoded.length)
  if (replacementRatio > 0.01) {
    return `[binary file, ${buffer.length} bytes]`
  }
  const truncated = buffer.length > MAX_BYTES
  return truncated ? `${decoded}\n...[truncated, ${buffer.length} bytes total]` : decoded
}

/** Resolve a path_or_url to image bytes. */
async function resolveMediaSource(source: string): Promise<Buffer> {
  if (/^https?:\/\//.test(source)) {
    const resp = await fetch(source)
    if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`)
    return Buffer.from(await resp.arrayBuffer())
  }
  return readFileSync(source)
}

/** Resolve a path_or_url to file bytes + a file name. */
async function resolveFileSource(source: string): Promise<{ buffer: Buffer; fileName: string }> {
  if (/^https?:\/\//.test(source)) {
    const resp = await fetch(source)
    if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`)
    const buffer = Buffer.from(await resp.arrayBuffer())
    const urlPath = new URL(source).pathname
    const fileName = urlPath.split('/').pop() || 'download'
    return { buffer, fileName }
  }
  const buffer = readFileSync(source)
  const fileName = source.split(/[\\/]/).pop() || 'file'
  return { buffer, fileName }
}

/** Guess the Feishu file_type from a file extension. */
function guessFileType(fileName: string): FeishuFileType {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'pdf': return 'pdf'
    case 'doc': case 'docx': return 'doc'
    case 'xls': case 'xlsx': return 'xls'
    case 'ppt': case 'pptx': return 'ppt'
    case 'mp4': case 'mp3': return 'mp4'
    case 'opus': case 'ogg': return 'opus'
    default: return 'stream'
  }
}

// Re-export the raw send helpers for the bridge to deliver into the chat.
export { sendFileLark, sendImageLark }
