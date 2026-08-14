/**
 * Media handling for harness-lark: upload images/files to Feishu IM
 * storage, download message resources, and send image/file/audio messages.
 * Ported from openclaw-lark's media.ts (MIT, ByteDance Ltd.), trimmed to
 * the core upload/download/send paths.
 */

import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import type * as Lark from '@larksuiteoapi/node-sdk'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadImageResult {
  /** The image_key assigned by Feishu, used to reference the image. */
  imageKey: string
}

export interface UploadFileResult {
  /** The file_key assigned by Feishu, used to reference the file. */
  fileKey: string
}

export interface DownloadResourceResult {
  buffer: Buffer
  contentType?: string
  fileName?: string
}

export interface SendMediaResult {
  messageId?: string
  chatId?: string
  ok: boolean
  error?: string
}

export type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Upload an image to Feishu IM storage.
 * @param client - The Lark SDK client.
 * @param image - Raw image bytes or a local file path.
 * @param imageType - "message" (default) or "avatar".
 */
export async function uploadImage(
  client: Lark.Client,
  image: Buffer | string,
  imageType: 'message' | 'avatar' = 'message',
): Promise<UploadImageResult> {
  const imageStream = Buffer.isBuffer(image) ? Readable.from(image) : Readable.from(readFileSync(image))
  const response = await client.im.image.create({
    data: { image_type: imageType, image: imageStream } as never,
  })
  const imageKey =
    (response.data as { image_key?: string } | undefined)?.image_key ??
    (response as unknown as { image_key?: string }).image_key
  if (!imageKey) {
    throw new Error(`[harness-lark] image upload failed: no image_key in response`)
  }
  return { imageKey }
}

/**
 * Upload a file to Feishu IM storage.
 * @param client - The Lark SDK client.
 * @param file - Raw file bytes or a local file path.
 */
export async function uploadFile(
  client: Lark.Client,
  file: Buffer | string,
  fileName: string,
  fileType: FeishuFileType,
  duration?: number,
): Promise<UploadFileResult> {
  const fileStream = Buffer.isBuffer(file) ? Readable.from(file) : Readable.from(readFileSync(file))
  const response = await client.im.file.create({
    data: {
      file_type: fileType,
      file_name: fileName,
      file: fileStream,
      ...(duration !== undefined ? { duration: String(duration) } : {}),
    } as never,
  })
  const fileKey =
    (response.data as { file_key?: string } | undefined)?.file_key ??
    (response as unknown as { file_key?: string }).file_key
  if (!fileKey) {
    throw new Error(`[harness-lark] file upload failed: no file_key in response for "${fileName}"`)
  }
  return { fileKey }
}

/** Read a local file as a Buffer (lazy import so CLI-only paths stay light). */
function requireFsRead(path: string): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  return fs.readFileSync(path)
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Download a resource (image or file) attached to a message.
 * @param client - The Lark SDK client.
 * @param messageId - The message the resource belongs to.
 * @param fileKey - The file_key or image_key of the resource.
 * @param type - Whether the resource is an "image" or "file".
 */
export async function downloadMessageResource(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
): Promise<DownloadResourceResult> {
  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  })

  const { buffer, contentType } = await extractBufferFromResponse(response as unknown)

  let fileName: string | undefined
  const resp = response as unknown as {
    headers?: Record<string, string>
  }
  const disposition = resp.headers?.['content-disposition'] ?? resp.headers?.['Content-Disposition']
  if (typeof disposition === 'string') {
    const match = disposition.match(/filename[*]?=(?:UTF-8'')?["']?([^"';\n]+)/i)
    if (match) fileName = decodeURIComponent(match[1].trim())
  }

  return { buffer, contentType, fileName }
}

/** Normalize the various SDK binary response shapes into a Buffer. */
async function extractBufferFromResponse(response: unknown): Promise<{ buffer: Buffer; contentType?: string }> {
  if (Buffer.isBuffer(response)) return { buffer: response }
  if (response instanceof ArrayBuffer) return { buffer: Buffer.from(response) }
  if (response == null) throw new Error('[harness-lark] media download: null response')

  const resp = response as Record<string, unknown>
  const contentType =
    (resp.headers as Record<string, string> | undefined)?.['content-type'] ??
    (resp.contentType as string | undefined)

  const data = resp.data
  if (data != null) {
    if (Buffer.isBuffer(data)) return { buffer: data, contentType }
    if (data instanceof ArrayBuffer) return { buffer: Buffer.from(data), contentType }
    if (typeof (data as { pipe?: unknown }).pipe === 'function') {
      return { buffer: await streamToBuffer(data as NodeJS.ReadableStream), contentType }
    }
  }

  if (typeof (resp as { getReadableStream?: unknown }).getReadableStream === 'function') {
    const stream = await (resp as { getReadableStream: () => Promise<unknown> }).getReadableStream()
    return { buffer: await streamToBuffer(stream as NodeJS.ReadableStream), contentType }
  }

  if (typeof (resp as { pipe?: unknown }).pipe === 'function') {
    return { buffer: await streamToBuffer(resp as unknown as NodeJS.ReadableStream), contentType }
  }

  throw new Error('[harness-lark] media download: unrecognised binary response format')
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Send media messages
// ---------------------------------------------------------------------------

/** Send an image message to a chat or user. */
export async function sendImage(
  client: Lark.Client,
  to: string,
  imageKey: string,
  receiveIdType: 'chat_id' | 'open_id' = 'chat_id',
): Promise<SendMediaResult> {
  return sendMediaMessage(client, to, JSON.stringify({ image_key: imageKey }), 'image', receiveIdType)
}

/** Send a file message to a chat or user. */
export async function sendFile(
  client: Lark.Client,
  to: string,
  fileKey: string,
  receiveIdType: 'chat_id' | 'open_id' = 'chat_id',
): Promise<SendMediaResult> {
  return sendMediaMessage(client, to, JSON.stringify({ file_key: fileKey }), 'file', receiveIdType)
}

/** Send an audio message to a chat or user. */
export async function sendAudio(
  client: Lark.Client,
  to: string,
  fileKey: string,
  receiveIdType: 'chat_id' | 'open_id' = 'chat_id',
): Promise<SendMediaResult> {
  return sendMediaMessage(client, to, JSON.stringify({ file_key: fileKey }), 'audio', receiveIdType)
}

async function sendMediaMessage(
  client: Lark.Client,
  to: string,
  content: string,
  msgType: 'image' | 'file' | 'audio' | 'media',
  receiveIdType: 'chat_id' | 'open_id',
): Promise<SendMediaResult> {
  try {
    const response = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, msg_type: msgType, content } as never,
    })
    const data = response.data as { message_id?: string; chat_id?: string } | undefined
    return { messageId: data?.message_id, chatId: data?.chat_id, ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}
