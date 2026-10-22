import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME,
  SKILL_IMPORT_SYSTEM_PROMPT_APPEND,
  createLocalSkillCreator,
  createSkillImportMcpServer,
  type SkillImportMcpHandler
} from './mcp-server'
import { setLocalRpcFetchForTesting } from '../local-rpc-transport'
import {
  SKILL_CREATE_TOOL_NAME,
  type SkillCreateInput,
  type SkillCreateResult
} from '../../shared/skill-create'
import {
  SKILL_EVAL_TOOL_NAME,
  SKILL_LIST_TOOL_NAME,
  SKILL_READ_TOOL_NAME
} from '../../shared/skill-eval'

describe('Skill import MCP server', () => {
  it('exposes one high-level request tool without exposing filesystem writes', async () => {
    const turnToken = '00000000-0000-4000-8000-000000000001'
    const requestImport = vi.fn().mockResolvedValue({
      status: 'imported',
      skills: [{ id: 'imported-demo', name: 'Demo', status: 'imported' }]
    })
    const requestGitHubImport = vi.fn().mockResolvedValue({
      status: 'imported',
      skills: [{ id: 'imported-slide-master', name: 'Slide Master', status: 'imported' }]
    })
    const server = createSkillImportMcpServer({
      requestImport,
      requestGitHubImport,
      createSkill: vi.fn(async () => ({
        created: true,
        skillName: 'probe',
        path: '/skills/probe'
      })),
      evalDescription: vi.fn(async () => ({
        score: 8,
        checks: [{ id: 'length', passed: true, message: 'ok' }],
        suggestions: []
      })),
      listSkills: vi.fn(async () => ({ skills: [] })),
      readSkill: vi.fn(async () => ({
        name: 'probe',
        description: 'Probe skill.',
        instructions: '# Probe\n\nBody.'
      }))
    })
    const client = new Client({ name: 'skill-import-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const tools = await client.listTools()
    expect(tools.tools).toEqual([
      expect.objectContaining({
        name: REQUEST_SKILL_IMPORT_TOOL_NAME,
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            attachment_uri: expect.any(Object),
            turn_token: expect.any(Object),
            github_url: expect.any(Object)
          })
        })
      }),
      expect.objectContaining({
        name: SKILL_CREATE_TOOL_NAME,
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            name: expect.any(Object),
            description: expect.any(Object),
            instructions: expect.any(Object)
          })
        })
      }),
      expect.objectContaining({
        name: SKILL_EVAL_TOOL_NAME,
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            description: expect.any(Object)
          })
        })
      }),
      expect.objectContaining({ name: SKILL_LIST_TOOL_NAME }),
      expect.objectContaining({
        name: 'capability_preflight',
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({ capability: expect.any(Object) })
        })
      }),
      expect.objectContaining({
        name: SKILL_READ_TOOL_NAME,
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            name: expect.any(Object)
          })
        })
      })
    ])

    const result = await client.callTool({
      name: REQUEST_SKILL_IMPORT_TOOL_NAME,
      arguments: {
        attachment_uri: 'file:///managed/session/demo.skill',
        turn_token: turnToken
      }
    })

    expect(requestImport).toHaveBeenCalledWith('file:///managed/session/demo.skill', turnToken)
    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('imported-demo') }]
    })

    const githubUrl = 'https://github.com/acme/skills/tree/main/slide-master'
    const githubResult = await client.callTool({
      name: REQUEST_SKILL_IMPORT_TOOL_NAME,
      arguments: { github_url: githubUrl }
    })
    expect(requestGitHubImport).toHaveBeenCalledWith(githubUrl)
    expect(githubResult).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('imported-slide-master') }]
    })
    const invalidGitHubResult = await client.callTool({
      name: REQUEST_SKILL_IMPORT_TOOL_NAME,
      arguments: { github_url: 'https://example.invalid/github.com/acme/skills' }
    })
    expect(invalidGitHubResult).toMatchObject({ isError: true })
    expect(requestGitHubImport).toHaveBeenCalledOnce()
    expect(SKILL_IMPORT_SYSTEM_PROMPT_APPEND).toContain(
      'When the user supplies only a Skill name or keywords'
    )
    expect(SKILL_IMPORT_SYSTEM_PROMPT_APPEND).toContain('first use available web search')
    expect(SKILL_IMPORT_SYSTEM_PROMPT_APPEND).toContain(
      'Do not download GitHub content into a temporary attachment'
    )
    expect(SKILL_IMPORT_SYSTEM_PROMPT_APPEND).toContain('install-skill-from-github.py')
    expect(SKILL_IMPORT_SYSTEM_PROMPT_APPEND).toContain('do not write to codex/skills')
    expect(SKILL_IMPORT_MCP_SERVER_NAME).toBe('purescience_skills')

    await client.close()
    await server.close()
  })
})

const temporaryConfigDirs: string[] = []

const makeConfigDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-create-'))
  temporaryConfigDirs.push(dir)
  return dir
}

afterEach(async () => {
  setLocalRpcFetchForTesting(undefined)
  while (temporaryConfigDirs.length > 0) {
    await rm(temporaryConfigDirs.pop()!, { recursive: true, force: true })
  }
})

const connectCreateTool = async (): Promise<{
  client: Client
  created: SkillCreateInput[]
  close: () => Promise<void>
}> => {
  const created: SkillCreateInput[] = []
  const handler: SkillImportMcpHandler = {
    requestImport: vi.fn(),
    requestGitHubImport: vi.fn(),
    createSkill: async (input) => {
      created.push(input)
      return { created: true, skillName: input.name } as SkillCreateResult
    },
    evalDescription: vi.fn(),
    listSkills: vi.fn(async () => ({ skills: [] })),
    readSkill: vi.fn()
  }
  const server = createSkillImportMcpServer(handler)
  const client = new Client({ name: 'skill-create-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    created,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

describe('create_skill: instructions or a recorded run, never both and never neither', () => {
  it('maps from_run_id to the compile form and refuses the second source of truth', async () => {
    const { client, created, close } = await connectCreateTool()
    try {
      const compiled = await client.callTool({
        name: SKILL_CREATE_TOOL_NAME,
        arguments: { name: 'check-pandas', description: 'Check pandas.', from_run_id: 'run-7' }
      })
      expect(compiled).toMatchObject({
        content: [{ type: 'text', text: expect.stringContaining('check-pandas') }]
      })
      expect(created).toEqual([
        {
          name: 'check-pandas',
          description: 'Check pandas.',
          instructions: '',
          fromRunId: 'run-7'
        }
      ])

      const conflicting = await client.callTool({
        name: SKILL_CREATE_TOOL_NAME,
        arguments: {
          name: 'check-pandas',
          description: 'Check pandas.',
          instructions: 'print(1)',
          from_run_id: 'run-7'
        }
      })
      expect(conflicting).toMatchObject({ isError: true })
      expect(JSON.stringify(conflicting)).toContain('do not pass instructions')
      expect(created).toHaveLength(1)

      const withoutEither = await client.callTool({
        name: SKILL_CREATE_TOOL_NAME,
        arguments: { name: 'check-pandas', description: 'Check pandas.' }
      })
      expect(withoutEither).toMatchObject({ isError: true })
      expect(JSON.stringify(withoutEither)).toContain('needs step-by-step instructions')
      expect(created).toHaveLength(1)
    } finally {
      await close()
    }
  })
})

describe('createLocalSkillCreator splits by what each form needs', () => {
  const environment = { endpoint: 'http://127.0.0.1:1', token: 'token', sessionId: 'session-1' }

  it('keeps the drafted form local: a real write into the config root, with no RPC call', async () => {
    setLocalRpcFetchForTesting(
      vi.fn(async () => {
        throw new Error('the drafted form must not use the app RPC')
      })
    )
    const configDir = await makeConfigDir()
    const createSkill = createLocalSkillCreator(configDir, environment)

    const result = await createSkill({
      name: 'check-pandas',
      description: 'Check pandas.',
      instructions: '# Check\n\nRun it.'
    })

    expect(result).toMatchObject({ created: true, skillName: 'check-pandas' })
    const document = await readFile(join(configDir, 'skills', 'check-pandas', 'SKILL.md'), 'utf8')
    expect(document).toContain('name: "check-pandas"')
    expect(document).toContain('Run it.')
  })

  it('sends a compile from a recorded run over the app RPC, and writes nothing here', async () => {
    const bodies: string[] = []
    setLocalRpcFetchForTesting(
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return new Response(
          JSON.stringify({
            result: {
              state: 'created',
              fingerprint: 'method-skill:v1-abc',
              runId: 'run-7',
              skillName: 'check-pandas'
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )
    const configDir = await makeConfigDir()
    const createSkill = createLocalSkillCreator(configDir, environment)

    const outcome = await createSkill({
      name: 'check-pandas',
      description: 'Check pandas.',
      instructions: '',
      fromRunId: 'run-7'
    })

    expect(outcome).toMatchObject({ state: 'created', fingerprint: 'method-skill:v1-abc' })
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]!)).toEqual({
      method: 'skillCreate',
      params: {
        sessionId: 'session-1',
        name: 'check-pandas',
        description: 'Check pandas.',
        instructions: '',
        fromRunId: 'run-7'
      }
    })
    // The compile is written by the main process: this transport must not touch the skills directory.
    await expect(readdir(join(configDir, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
