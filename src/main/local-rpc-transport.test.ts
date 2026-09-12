import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { fetchLocalRpc, listenForLocalRpc, localRpcServerLogFields } from './local-rpc-transport'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

describe('local RPC transport', () => {
  it('uses node:http (not the global fetch) for loopback TCP', async () => {
    // Regression: the TCP path called the global fetch, i.e. undici, whose default headersTimeout of
    // 300 s aborted any app-local call that legitimately ran longer. A long notebook cell surfaced as
    // "Notebook RPC transport failed: UND_ERR_HEADERS_TIMEOUT" and left half-written artifacts. The
    // global fetch must therefore never be used for app-local RPC — stub it to explode.
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      }, 30)
    })
    servers.push(server)
    const connection = await listenForLocalRpc(server, { name: 'transport-tcp-test' })
    expect(connection.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('global fetch (undici) must not serve app-local RPC')
    }) as typeof fetch
    try {
      const response = await fetchLocalRpc(
        { endpoint: `${connection.endpoint}/rpc` },
        { method: 'POST', body: JSON.stringify({ protocolVersion: 1 }) },
        'Notebook RPC'
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('posts JSON through a local socket without loopback TCP', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ path: request.url, authorized: request.headers.authorization }))
    })
    servers.push(server)
    const connection = await listenForLocalRpc(server, {
      name: 'transport-test',
      transport: 'pipe'
    })

    expect(connection.socketPath).toBeTruthy()
    expect(localRpcServerLogFields(server)).toEqual({
      transport: 'pipe',
      listening: true,
      socketPath: connection.socketPath
    })
    const response = await fetchLocalRpc(
      { ...connection, endpoint: `${connection.endpoint}/rpc` },
      {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'state' })
      },
      'Test RPC'
    )

    await expect(response.json()).resolves.toEqual({
      path: '/rpc',
      authorized: 'Bearer test-token'
    })
  })

  it('reports the bound TCP host, port, and listening state', async () => {
    const server = createServer()
    servers.push(server)
    await listenForLocalRpc(server, { name: 'transport-test', transport: 'tcp' })

    expect(localRpcServerLogFields(server)).toMatchObject({
      transport: 'tcp',
      listening: true,
      host: '127.0.0.1',
      port: expect.any(Number)
    })
  })

  it('keeps the underlying socket error in the diagnostic', async () => {
    await expect(
      fetchLocalRpc(
        { endpoint: 'http://localhost', socketPath: '/missing/purescience.sock' },
        { method: 'POST' },
        'Notebook RPC'
      )
    ).rejects.toThrow(/Notebook RPC transport failed:.*ENOENT/i)
  })
})
