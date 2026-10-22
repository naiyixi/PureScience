// `capability_preflight` over the server's own transport: the thing the agent actually calls.
//
// The point of these cases is the REFUSALS, not the happy path: a preflight that answers "ready" when
// it could not read the session would be worse than no preflight at all, because a model would act on
// it. So: no dep → named error; missing capability → named error; unknown session → named error.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'

let server: NotebookLocalRpcServer | undefined
const temporary: string[] = []

const makeDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

afterEach(async () => {
  await server?.close()
  server = undefined
  while (temporary.length > 0) await rm(temporary.pop()!, { recursive: true, force: true })
})

type PreflightCall = { sessionId: string; capability: string }

const start = async (
  capabilityPreflight?: (input: PreflightCall) => Promise<unknown>
): Promise<{ post: (params: Record<string, unknown>) => Promise<Response> }> => {
  const configDir = await makeDir('ps-skills-')
  void configDir
  server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
    transport: 'tcp',
    token: 'secret-token',
    ...(capabilityPreflight ? { capabilityPreflight } : {})
  })
  server.registerSessionAlias('pre-session-alias', 'session-1')
  const { endpoint, token } = await server.issueSkillImportConnection('pre-session-alias')

  return {
    post: (params) =>
      fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'capabilityPreflight', params })
      })
  }
}

describe('capability_preflight over the local RPC transport', () => {
  it('answers about the session it was issued for, with the caller capability', async () => {
    const calls: PreflightCall[] = []
    const { post } = await start(async (input) => {
      calls.push(input)
      return {
        capability: input.capability,
        status: 'missing_state',
        missing: ['input:omics_file']
      }
    })

    const response = await post({ sessionId: 'pre-session-alias', capability: ' needs-matrix ' })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as { result: { status: string; missing: string[] } }
    expect(payload.result).toMatchObject({
      capability: 'needs-matrix',
      status: 'missing_state',
      missing: ['input:omics_file']
    })
    // The alias is resolved before the dependency sees it, so facts are read for the real session.
    expect(calls).toEqual([{ sessionId: 'session-1', capability: 'needs-matrix' }])
  })

  it('refuses when capability is missing, rather than checking an empty name', async () => {
    const { post } = await start(async () => ({ status: 'ready' }))

    const response = await post({ sessionId: 'pre-session-alias', capability: '  ' })

    expect(response.ok).toBe(false)
    const payload = (await response.json()) as { error: string }
    expect(payload.error).toContain('must include sessionId and capability')
  })

  it('refuses when no preflight is configured on this server', async () => {
    const { post } = await start()

    const response = await post({ sessionId: 'pre-session-alias', capability: 'needs-matrix' })

    expect(response.ok).toBe(false)
    const payload = (await response.json()) as { error: string }
    expect(payload.error).toContain('not configured')
  })

  it('refuses an unknown session instead of returning an empty reading', async () => {
    const { post } = await start(async () => null)

    const response = await post({ sessionId: 'gone', capability: 'needs-matrix' })

    expect(response.ok).toBe(false)
    const payload = (await response.json()) as { error: string }
    expect(payload.error).toContain('No session for capability preflight')
  })
})
