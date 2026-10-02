import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createInMemoryScreeningClient } from '../../../test/fixtures/in-memory-screening-client'
import type { Reference } from '../../shared/references'
import type { ReferenceRepository } from './repository'
import { ScreeningRepository } from './screening-repository'

// The registry is captured instead of installed: what matters here is which channels exist and what they
// hand to the module, not how Electron wires them (the same seam search-pin-ipc.test.ts uses).
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('../ipc-handler-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc-handler-registry')>()
  return {
    ...actual,
    ipcMainHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
})

const { createReferencesIpcModule, installReferencesIpcHandlers } = await import('./ipc')

// The screening channels are real round trips through the module: the repository, the engine and the
// projection are the production ones, and only the model is a stub. That is what makes "the button does
// something" checkable at the IPC boundary rather than in the window.

const COLLECTION = 'col-1'

const reference = (id: string): Reference => ({
  id,
  projectId: 'project-1',
  title: `Title for ${id}`,
  authors: [{ name: 'Ada Lovelace' }],
  venue: 'Journal of Tests',
  year: 2024,
  doi: undefined,
  pmid: undefined,
  pmcid: undefined,
  arxivId: undefined,
  url: undefined,
  abstractSnippet: undefined,
  sourceConnector: 'manual',
  sourceRecordId: undefined,
  citationKey: `key-${id}`,
  provenance: undefined,
  pdfManagedFileId: undefined,
  notes: undefined,
  createdAt: 1,
  updatedAt: 1
})

const FULL_TEXT = 'We enrolled 120 adults and measured the primary endpoint over twelve weeks.'

const INCLUDED_ANSWER = JSON.stringify({
  verdict: 'included',
  probabilities: { include: 0.9 },
  citations: [{ criterionId: 'i-1', quote: 'We enrolled 120 adults' }],
  refutation: null
})

type Harness = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  setGate: (gate: Promise<void> | null) => void
}

const installModule = (
  references: readonly Reference[],
  options: { fullText?: (reference: Reference) => Promise<string | null> } = {}
): Harness => {
  const client = createInMemoryScreeningClient()
  const byId = new Map(references.map((entry) => [entry.id, entry]))
  const referenceRepository = {
    listReferencesByCollection: async () => [...references],
    getReference: async (referenceId: string) => byId.get(referenceId) ?? null,
    listReferences: async () => [...references]
  } as unknown as ReferenceRepository
  let gate: Promise<void> | null = null
  const module = createReferencesIpcModule(
    referenceRepository,
    {},
    // The citation-style store is not exercised here; the default is lazy, so no database is touched.
    undefined as never,
    new ScreeningRepository(async () => client)
  )
  module.bindScreening({
    runner: () => ({
      model: 'stub-model-v1',
      run: async () => {
        if (gate) await gate
        return { text: INCLUDED_ANSWER }
      }
    }),
    readFullText: options.fullText ?? (async () => FULL_TEXT)
  })
  installReferencesIpcHandlers(module)
  return {
    invoke: async (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`channel ${channel} is not installed`)
      return handler({}, ...args)
    },
    setGate: (next) => {
      gate = next
    }
  }
}

const inclusion = [{ id: 'i-1', text: '研究对象为成年人' }]
const exclusion = [{ id: 'e-1', text: '综述、社论、病例报告' }]

const pollUntilIdle = async (
  invoke: Harness['invoke'],
  timeoutMs = 5_000
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = (await invoke('references:get-screening', COLLECTION)) as {
      lastRun: { running: boolean } | null
    }
    if (!snapshot.lastRun?.running) return snapshot as Record<string, unknown>
    if (Date.now() > deadline) throw new Error('the pass never finished')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  handlers.clear()
})

describe('references IPC: the screening surface', () => {
  it('installs exactly the library channels plus the screening ones, and no others', () => {
    installModule([reference('ref-a')])

    expect([...handlers.keys()].sort()).toEqual(
      [
        'references:add',
        'references:add-to-collection',
        'references:append-screening-rule-revision',
        'references:attach-pdf',
        'references:cancel-screening-run',
        'references:clear-screening-override',
        'references:create-collection',
        'references:delete-collection',
        'references:detach-pdf',
        'references:fetch-by-identifier',
        'references:get-screening',
        'references:import-citation-style',
        'references:import-dois-from-pdf',
        'references:import-journal-metrics',
        'references:list',
        'references:list-citation-styles',
        'references:list-collections',
        'references:list-journal-metrics',
        'references:list-screening-rule-revisions',
        'references:merge',
        'references:remove',
        'references:remove-citation-style',
        'references:remove-from-collection',
        'references:set-screening-override',
        'references:set-screening-overrides',
        'references:start-screening-run'
      ].sort()
    )
  })

  it('reads the collection state, appends a revision, runs a pass, and layers an override over the AI verdict', async () => {
    const { invoke } = installModule([reference('ref-a')])

    const empty = (await invoke('references:get-screening', COLLECTION)) as {
      rule: unknown
      summary: { candidateCount: number; unprocessedCount: number }
      items: { decision: { verdict: string } }[]
      runnerAvailable: boolean
    }
    expect(empty.rule).toBeNull()
    expect(empty.summary).toMatchObject({ candidateCount: 1, unprocessedCount: 1 })
    expect(empty.items[0].decision.verdict).toBe('not-evaluated')
    // The runner was bound by bindScreening, so a pass can start.
    expect(empty.runnerAvailable).toBe(true)

    const appended = (await invoke('references:append-screening-rule-revision', {
      collectionId: COLLECTION,
      inclusion,
      exclusion
    })) as { appended: boolean; revision: { revision: number } }
    expect(appended.appended).toBe(true)
    expect(appended.revision.revision).toBe(1)

    const revisions = (await invoke('references:list-screening-rule-revisions', COLLECTION)) as {
      revision: number
    }[]
    expect(revisions.map((entry) => entry.revision)).toEqual([1])

    const started = (await invoke('references:start-screening-run', {
      collectionId: COLLECTION
    })) as { started: boolean; runId: string; referenceCount: number }
    expect(started.started).toBe(true)
    expect(started.referenceCount).toBe(1)

    const settled = (await pollUntilIdle(invoke)) as {
      items: {
        referenceId: string
        decision: { verdict: string; effective: string; effectiveSource: string; override: unknown }
        evidence: { criterionId: string; quote: string }[]
      }[]
      aiDecidedCount: number
      overrideCount: number
    }
    expect(settled.items[0].decision.verdict).toBe('included')
    expect(settled.items[0].decision.effectiveSource).toBe('ai')
    expect(settled.items[0].evidence).toEqual([
      { criterionId: 'i-1', coverage: 'full-text', quote: 'We enrolled 120 adults' }
    ])
    expect(settled.aiDecidedCount).toBe(1)

    const overridden = (await invoke('references:set-screening-override', {
      collectionId: COLLECTION,
      referenceId: 'ref-a',
      decision: 'exclude',
      reason: 'the cohort is paediatric',
      actor: 'user'
    })) as {
      decision: { verdict: string; effective: string; effectiveSource: string; override: unknown }
    }
    // The channel answers with the updated line: the AI verdict is still the model's, the human layer
    // sits beside it, and the effective decision is the person's.
    expect(overridden.decision.verdict).toBe('included')
    expect(overridden.decision.effective).toBe('excluded')
    expect(overridden.decision.effectiveSource).toBe('override')
    expect(overridden.decision.override).toMatchObject({ reason: 'the cohort is paediatric' })

    const cleared = (await invoke('references:clear-screening-override', COLLECTION, 'ref-a')) as {
      referenceId: string
      item: { decision: { effective: string; effectiveSource: string; override: unknown } }
    }
    expect(cleared.referenceId).toBe('ref-a')
    expect(cleared.item.decision.override).toBeNull()
    expect(cleared.item.decision.effective).toBe('included')
    expect(cleared.item.decision.effectiveSource).toBe('ai')
  })

  it('applies a batch override and reports it as a count, with every line read back', async () => {
    const { invoke } = installModule([reference('ref-a'), reference('ref-b')])
    await invoke('references:append-screening-rule-revision', {
      collectionId: COLLECTION,
      inclusion,
      exclusion
    })
    await invoke('references:start-screening-run', { collectionId: COLLECTION })
    await pollUntilIdle(invoke)

    const batch = (await invoke('references:set-screening-overrides', {
      collectionId: COLLECTION,
      referenceIds: ['ref-a', 'ref-b'],
      decision: 'include',
      reason: 'both match the protocol',
      actor: 'user'
    })) as { applied: number; items: { referenceId: string; decision: { override: unknown } }[] }

    expect(batch.applied).toBe(2)
    expect(batch.items.map((item) => item.referenceId)).toEqual(['ref-a', 'ref-b'])
    expect(batch.items.every((item) => item.decision.override !== null)).toBe(true)
  })

  it('stops a running pass through the channel and leaves the rest pending for a resume', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Nine references, one more than the service's default chunk of eight. The model answers the first
    // record and hangs on every later one, so the cancel lands while the first chunk is genuinely in
    // flight and the ninth record is never looked at — which is what "the rest stays pending" means.
    let call = 0
    const references = Array.from({ length: 9 }, (_entry, index) => reference(`ref-${index}`))
    const client = createInMemoryScreeningClient()
    const module = createReferencesIpcModule(
      {
        listReferencesByCollection: async () => references,
        getReference: async (referenceId: string) =>
          references.find((entry) => entry.id === referenceId) ?? null,
        listReferences: async () => references
      } as unknown as ReferenceRepository,
      {},
      undefined as never,
      new ScreeningRepository(async () => client)
    )
    module.bindScreening({
      runner: () => ({
        model: 'stub-model-v1',
        run: async () => {
          call += 1
          if (call > 1) await gate
          return { text: INCLUDED_ANSWER }
        }
      }),
      readFullText: async () => FULL_TEXT
    })
    installReferencesIpcHandlers(module)
    const invoke: Harness['invoke'] = async (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`channel ${channel} is not installed`)
      return handler({}, ...args)
    }

    await invoke('references:append-screening-rule-revision', {
      collectionId: COLLECTION,
      inclusion,
      exclusion
    })
    const started = (await invoke('references:start-screening-run', {
      collectionId: COLLECTION
    })) as { runId: string; referenceCount: number }
    expect(started.referenceCount).toBe(9)

    // One record is decided before the cancel is asked for, so the stop is a stop in the middle of work
    // rather than a refusal to begin.
    await vi.waitFor(async () => {
      const snapshot = (await invoke('references:get-screening', COLLECTION)) as {
        lastRun: { assessed: number } | null
      }
      expect(snapshot.lastRun?.assessed).toBe(1)
    })

    const cancelled = (await invoke('references:cancel-screening-run', COLLECTION)) as {
      cancelled: boolean
      runId: string
      remaining: number
    }
    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.runId).toBe(started.runId)
    expect(cancelled.remaining).toBe(8)

    release?.()
    await vi.waitFor(async () => {
      const snapshot = (await invoke('references:get-screening', COLLECTION)) as {
        lastRun: { running: boolean; pending: number; run: { status: string } } | null
      }
      expect(snapshot.lastRun?.running).toBe(false)
      expect(snapshot.lastRun?.pending).toBe(1)
      // A stopped pass is NOT marked finished: it stays 'running' with its pending row, which is exactly
      // the state a resume continues from.
      expect(snapshot.lastRun?.run.status).toBe('running')
    })

    // Nothing is running any more, so a second cancel says so instead of inventing a run.
    const again = (await invoke('references:cancel-screening-run', COLLECTION)) as {
      cancelled: boolean
    }
    expect(again.cancelled).toBe(false)
  })

  it('answers a snapshot without the model runner bound, and refuses to open a pass', async () => {
    const client = createInMemoryScreeningClient()
    const module = createReferencesIpcModule(
      {
        listReferencesByCollection: async () => [reference('ref-a')],
        getReference: async () => reference('ref-a'),
        listReferences: async () => [reference('ref-a')]
      } as unknown as ReferenceRepository,
      {},
      undefined as never,
      new ScreeningRepository(async () => client)
    )
    installReferencesIpcHandlers(module)

    const snapshot = (await handlers.get('references:get-screening')?.({}, COLLECTION)) as {
      runnerAvailable: boolean
      lastRun: unknown
    }
    expect(snapshot.runnerAvailable).toBe(false)
    expect(snapshot.lastRun).toBeNull()

    await expect(
      handlers.get('references:start-screening-run')?.({}, { collectionId: COLLECTION })
    ).rejects.toThrow(/model runner is not available/)
  })
})
