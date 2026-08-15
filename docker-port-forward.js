#!/usr/bin/env node
/**
 * Tiny TCP forwarder for the dsh web UI.
 *
 * dsh's web server deliberately binds only the container loopback
 * (--host 0.0.0.0 is refused for safety, see web-app startup). Docker's
 * published port forwards to the container's bridge IP, which nothing
 * listens on. This forwarder listens on the container's own eth0 IP
 * (default `auto` = first non-internal IPv4) and pipes into the loopback-
 * bound web server, so `-p host:3080:3080` works while dsh keeps its
 * safety posture. Binding the specific container IP (not the wildcard)
 * avoids EADDRINUSE against dsh's loopback listener.
 *
 * Usage: node dsh-port-forward.js <port> [bindHost=auto] [targetHost=127.0.0.1]
 */

const net = require('net')
const os = require('os')

const port = Number(process.argv[2] || 3080)
const bindHostArg = process.argv[3] || 'auto'
const targetHost = process.argv[4] || '127.0.0.1'

/** First non-internal IPv4 address of this container. */
function containerIp() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

const bindHost = bindHostArg === 'auto' ? containerIp() : bindHostArg
if (!bindHost) {
  console.error('[dsh-port-forward] no external IPv4 address to bind; skipping')
  process.exit(0)
}

const server = net.createServer((socket) => {
  const upstream = net.connect(port, targetHost, () => {
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.on('error', (error) => {
  console.error(`[dsh-port-forward] failed to listen on ${bindHost}:${port}: ${error.message}`)
  process.exit(1)
})

server.listen({ port, host: bindHost, reuseAddress: true }, () => {
  console.log(`[dsh-port-forward] ${bindHost}:${port} -> ${targetHost}:${port}`)
})
