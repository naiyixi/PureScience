// Tests for external compute dispatch: provider-id routing in the dispatcher and the Modal / NIM
// execution branches.

import { describe, expect, it } from 'vitest'

import type { ExternalComputeEndpoint } from '../../shared/compute'
import { isExternalComputeProviderId } from '../../shared/compute'

const modalEndpoint: ExternalComputeEndpoint = {
  id: 'e1',
  providerId: 'modal:my-gpu',
  kind: 'modal',
  displayName: 'My GPU',
  credentialId: 'cred-1',
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  createdAt: 1,
  updatedAt: 1
}

const nimEndpoint: ExternalComputeEndpoint = {
  id: 'e2',
  providerId: 'nvidia_nim:local-nim',
  kind: 'nvidia_nim',
  displayName: 'Local NIM',
  credentialId: 'cred-2',
  baseUrl: 'http://127.0.0.1:8000/v1',
  modelName: 'meta/llama-3.1-8b-instruct',
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  createdAt: 1,
  updatedAt: 1
}

describe('external compute provider ids', () => {
  it('recognizes modal and nvidia_nim provider ids', () => {
    expect(isExternalComputeProviderId('modal:my-gpu')).toBe(true)
    expect(isExternalComputeProviderId('nvidia_nim:local')).toBe(true)
    expect(isExternalComputeProviderId('ssh:cluster')).toBe(false)
  })
})

describe('NIM execution branch', () => {
  it('calls the OpenAI-compatible endpoint and returns model output', async () => {
    const { runNimJob } = await import('./external-runner')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'model-answer' } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch

    try {
      const outcome = await runNimJob(nimEndpoint, 'what is 2+2?', 'nim-key')
      expect(outcome.exitCode).toBe(0)
      expect(outcome.stdout).toContain('model-answer')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns an error when the NIM endpoint refuses', async () => {
    const { runNimJob } = await import('./external-runner')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('denied', { status: 401 })) as typeof fetch

    try {
      const outcome = await runNimJob(nimEndpoint, 'prompt', 'bad-key')
      expect(outcome.exitCode).toBe(1)
      expect(outcome.stderr).toContain('401')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Modal execution branch', () => {
  it('invokes the modal CLI with the job command', async () => {
    const { runModalJob } = await import('./external-runner')
    // Without a real modal CLI the execFile fails; the runner must surface a non-zero outcome
    // rather than throwing.
    const outcome = await runModalJob(modalEndpoint, 'echo hi', {
      MODAL_TOKEN_ID: 'ak-test',
      MODAL_TOKEN_SECRET: 'ak-test'
    })
    expect(outcome.exitCode).toBe(1)
    expect(outcome.stderr.length).toBeGreaterThan(0)
  })
})
