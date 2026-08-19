/**
 * Host-side settings API for the harness-lark Web settings section.
 *
 * The DSH settings RPC domain does not serve third-party namespaces to
 * configuration clients (settings.describe/update are loopback-privileged),
 * so the Web form reads/writes the `harness-lark` namespace through this
 * plugin-owned route (`/lark/api/settings.*`), exactly like better-sidebar's
 * fenced `/sidebar/api` channel. The same browser-trust fence guards it.
 *
 * @module harness-lark/settings-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { HarnessLarkAgent } from './core/config-schema.ts'
import { isTrustedApiRequest, type TrustedHostsSource } from './trust-fence.ts'

/** JSON body of one settings API request. */
interface SettingsApiRequest {
  agents?: HarnessLarkAgent[]
}

/** The plugin-owned settings route prefix. */
const SETTINGS_API_PREFIX = '/lark/api'

/**
 * Register the harness-lark settings HTTP API.
 * @param ctx - host context with `webServer` and `settings` services.
 * @param deps - agent read/write sources.
 * @returns the disposer that unregisters the route.
 */
export function registerSettingsApi(
  ctx: Context,
  deps: {
    /** Current agents (settings > config > env fallback). */
    getAgents: () => HarnessLarkAgent[]
    /** Persist agents to the settings namespace. */
    saveAgents: (agents: HarnessLarkAgent[]) => Promise<void>
    /** Live trusted-host authorities (web runtime). */
    trustedHosts: TrustedHostsSource
  },
): () => void {
  let dispose: (() => void) | undefined
  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.webServer as
      | { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
      | undefined
    if (webServer === undefined) {
      console.warn('[harness-lark] webServer service unavailable — settings API not registered')
      return
    }
    dispose = webServer.register({
      kind: 'prefix',
      path: SETTINGS_API_PREFIX,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, deps.trustedHosts())) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith(`${SETTINGS_API_PREFIX}/`)
          ? pathname.slice(`${SETTINGS_API_PREFIX}/`.length)
          : undefined

        try {
          if (method === 'settings.get') {
            writeJson(res, 200, { ok: true, agents: deps.getAgents() })
            return
          }
          if (method === 'settings.set') {
            const body = await readJsonBody(req)
            const agents = Array.isArray(body?.agents) ? body.agents as HarnessLarkAgent[] : []
            await deps.saveAgents(agents)
            writeJson(res, 200, { ok: true, agents })
            return
          }
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method ${method ?? ''}` } })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
        }
      },
    })
  })

  return () => { dispose?.() }
}

/** Read and parse a JSON request body (capped). */
function readJsonBody(req: IncomingMessage): Promise<SettingsApiRequest | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw) as SettingsApiRequest)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

/** Write a JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** The settings namespace used by this plugin (mirrors index.ts). */
export const HARNESS_LARK_SETTINGS_NS = settingsNamespace('harness-lark')
