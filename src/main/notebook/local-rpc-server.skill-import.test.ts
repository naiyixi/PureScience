import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('NotebookLocalRpcServer Skill import bridge', () => {
  it('routes an MCP Skill import request through the final conversation id', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'imported',
      skills: [{ id: 'imported-demo', name: 'Demo', status: 'imported' }]
    })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      token: 'secret-token',
      skillImporter: { request }
    })
    server.registerSessionAlias('pre-session-alias', 'session-1')
    const { endpoint, token } = await server.issueSkillImportConnection('pre-session-alias')

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillImport',
        params: {
          sessionId: 'pre-session-alias',
          turnToken: '00000000-0000-4000-8000-000000000001',
          attachmentUri: 'file:///managed/session/demo.skill'
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: {
        status: 'imported',
        skills: [{ id: 'imported-demo', name: 'Demo', status: 'imported' }]
      }
    })
    expect(request).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnToken: '00000000-0000-4000-8000-000000000001',
      attachmentUri: 'file:///managed/session/demo.skill'
    })
  })

  it('routes a GitHub Skill import through the active conversation', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'cancelled', skills: [] })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      token: 'secret-token',
      skillImporter: { request }
    })
    server.registerSessionAlias('pre-session-alias', 'session-1')
    const { endpoint, token } = await server.issueSkillImportConnection('pre-session-alias')
    const githubUrl = 'https://github.com/acme/skills/tree/main/slide-master'

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillImport',
        params: { sessionId: 'another-session', githubUrl }
      })
    })

    expect(response.status).toBe(200)
    expect(request).toHaveBeenCalledWith({ sessionId: 'session-1', githubUrl })

    const mixedSourceResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillImport',
        params: {
          sessionId: 'pre-session-alias',
          githubUrl,
          turnToken: '00000000-0000-4000-8000-000000000001',
          attachmentUri: 'file:///managed/session/demo.skill'
        }
      })
    })
    expect(mixedSourceResponse.status).toBe(500)
    expect(request).toHaveBeenCalledOnce()
  })

  it('lets the session-bound skill capability create a skill, not only import one', async () => {
    // create_skill and request_skill_import are two tools of ONE MCP server, so they arrive on the same
    // connection: a capability that allows the import but not the creation makes the tool 403 while the
    // tool list still advertises it (a dead button, except the agent is the one pressing it).
    const create = vi.fn().mockResolvedValue({
      created: true,
      skillName: 'demo-skill',
      verification: 'unverified'
    })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      token: 'secret-token',
      skillCreator: { create }
    })
    server.registerSessionAlias('pre-session-alias', 'session-1')
    const { endpoint, token } = await server.issueSkillImportConnection('pre-session-alias')

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillCreate',
        params: {
          sessionId: 'pre-session-alias',
          name: 'demo-skill',
          description: 'Does a thing',
          instructions: '1. do it'
        }
      })
    })

    expect(response.status).toBe(200)
    expect(create).toHaveBeenCalledWith({
      name: 'demo-skill',
      description: 'Does a thing',
      instructions: '1. do it'
    })
  })

  it('forwards kind and evidence to the creator instead of dropping them on the wire', async () => {
    // The tool schema promises `kind` and `evidence`; the RPC handler used to rebuild the input from
    // four fields only, so a failure-mode entry arrived at the creator as an unverified procedure with
    // no reproduction — the one shape the gate exists to refuse.
    const create = vi.fn().mockResolvedValue({ created: true, skillName: 'vina-dead-end' })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      token: 'secret-token',
      skillCreator: { create }
    })
    server.registerSessionAlias('pre-session-alias', 'session-1')
    const { endpoint, token } = await server.issueSkillImportConnection('pre-session-alias')
    const post = (params: Record<string, unknown>): Promise<Response> =>
      fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'skillCreate', params })
      })

    const forwarded = await post({
      sessionId: 'pre-session-alias',
      name: 'vina-dead-end',
      description: 'The pip build of vina cannot work here',
      instructions: 'Do not try to pip install vina.',
      kind: 'failure-mode',
      evidence: ['pip install vina → clang: error: unsupported option']
    })

    expect(forwarded.status).toBe(200)
    expect(create).toHaveBeenCalledWith({
      name: 'vina-dead-end',
      description: 'The pip build of vina cannot work here',
      instructions: 'Do not try to pip install vina.',
      kind: 'failure-mode',
      evidence: ['pip install vina → clang: error: unsupported option']
    })

    const unknownKind = await post({
      sessionId: 'pre-session-alias',
      name: 'vina-dead-end',
      description: 'The pip build of vina cannot work here',
      instructions: 'x',
      kind: 'rumour'
    })
    expect(unknownKind.status).toBe(500)
    await expect(unknownKind.json()).resolves.toEqual({
      error: 'Skill create RPC kind must be one of procedure, failure-mode.'
    })
    expect(create).toHaveBeenCalledOnce()
  })

  it('rejects shared and out-of-scope RPC capabilities', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'cancelled', skills: [] })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      token: 'secret-token',
      skillImporter: { request }
    })
    const connection = await server.issueSkillImportConnection('session-1')
    const githubUrl = 'https://github.com/acme/skills/tree/main/slide-master'

    const sharedTokenResponse = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'skillImport',
        params: { sessionId: 'session-1', githubUrl }
      })
    })
    const outOfScopeResponse = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ method: 'listRuntimes', params: {} })
    })
    connection.release?.()
    const releasedTokenResponse = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ method: 'skillImport', params: { githubUrl } })
    })

    expect(sharedTokenResponse.status).toBe(401)
    expect(outOfScopeResponse.status).toBe(403)
    expect(releasedTokenResponse.status).toBe(401)
    expect(request).not.toHaveBeenCalled()
  })
})
