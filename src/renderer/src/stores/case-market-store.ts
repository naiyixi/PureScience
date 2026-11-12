import { create } from 'zustand'

import type { CaseInstallOutcome } from '../../../shared/case-bundle'
import type { CaseMarketplaceEntry } from '../../../shared/case-marketplace'

// The case market shelf is data from another machine, so it lives in a store rather than in component state: the
// read happens once, a reader can come back to the section without re-downloading the index, and the component only
// renders what is already here.
//
// The refusals this store keeps are the ones the main process produced — verbatim. It never invents a friendlier
// sentence: "the archive does not match the digest the index pins" is the useful sentence, "failed" is not.

export type CaseShelf =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      cases: ReadonlyArray<CaseMarketplaceEntry>
      updatedAt: number
      /**
       * Where this list came from. `cache` is this machine's saved copy: the shelf answers from it instead of making
       * the reader wait on a host that may not answer, and the card says so rather than looking like a live read.
       */
      source: 'network' | 'cache'
      /** When those bytes were fetched, in epoch ms. */
      fetchedAt: number
    }
  | {
      kind: 'refused'
      reason: 'unreachable' | 'bad-response' | 'too-large' | 'bad-index'
      detail?: string
    }
  // A window whose main process has no such channel (an older main under a newer window, or a surface that failed
  // to install) reads as unavailable with the reason it gave — never as a thrown rejection, which would leave the
  // home page's error channel carrying a TypeError the reader cannot act on.
  | { kind: 'unavailable'; detail?: string }

export type CaseInstallState =
  | { kind: 'idle' }
  | { kind: 'working'; id: string }
  | { kind: 'installed'; id: string; name: string; fileCount: number; installedTo: string }
  | {
      kind: 'refused'
      id: string
      reason: Extract<CaseInstallOutcome, { status: 'refused' }>['reason']
      detail?: string
      problematic?: { missing: string[]; checksumMismatch: string[]; unexpected: string[] }
    }

type CaseMarketStore = {
  shelf: CaseShelf
  install: CaseInstallState
  /** True while a read is in flight, so two mounts in the same tick do not both ask. */
  reading: boolean
  /** Epoch ms when this session last finished a read (a refusal counts); null until one finishes. */
  readAt: number | null
  /** Reads the index unless this session already read it; `force` re-reads (the refresh control uses it). */
  load: (options?: { force?: boolean }) => Promise<void>
  installCase: (entry: CaseMarketplaceEntry) => Promise<void>
}

export const useCaseMarketStore = create<CaseMarketStore>((set, get) => ({
  shelf: { kind: 'loading' },
  install: { kind: 'idle' },
  reading: false,
  readAt: null,

  load: async (options) => {
    // One read per session. The comment above promised this and the code did not do it: every mount of the shelf
    // asked again, so a reader who left the home page and came back paid for the index again — and on a network
    // where that host does not answer, paid the whole deadline again (measured: the same reader, four slow reads
    // in twenty minutes). A refusal is kept, not retried on mount: the refresh control is how a reader asks again.
    if (options?.force !== true && (get().reading === true || typeof get().readAt === 'number')) {
      return
    }
    const api = window.api?.caseBundles?.fetchMarketplace
    // A window built without the channel simply has no shelf; it must not throw.
    if (!api) {
      set({ shelf: { kind: 'unavailable' }, reading: false, readAt: Date.now() })
      return
    }
    set({ shelf: { kind: 'loading' }, reading: true })
    // `force` is the reader asking the host again: without it in the request the main process would answer from this
    // machine's saved copy and the reload control would look like it did nothing.
    const request = options?.force === true ? { refresh: true } : {}
    let outcome: Awaited<ReturnType<typeof window.api.caseBundles.fetchMarketplace>>
    try {
      outcome = await window.api.caseBundles.fetchMarketplace(request)
    } catch (error) {
      // `No handler registered for 'cases:marketplace'` arrives as a rejection, not as a refusal: the channel
      // itself is missing. That is exactly the case this branch is for, and the message is kept verbatim.
      set({
        shelf: {
          kind: 'unavailable',
          detail: error instanceof Error ? error.message : String(error)
        },
        reading: false,
        readAt: Date.now()
      })
      return
    }
    set({
      shelf:
        outcome.status === 'ok'
          ? {
              kind: 'ready',
              cases: outcome.cases,
              updatedAt: outcome.updatedAt,
              source: outcome.source,
              fetchedAt: outcome.fetchedAt
            }
          : {
              kind: 'refused',
              reason: outcome.reason,
              ...(outcome.detail === undefined ? {} : { detail: outcome.detail })
            },
      reading: false,
      readAt: Date.now()
    })
  },

  installCase: async (entry) => {
    set({ install: { kind: 'working', id: entry.id } })
    let outcome: Awaited<ReturnType<typeof window.api.caseBundles.installFromMarketplace>>
    try {
      outcome = await window.api.caseBundles.installFromMarketplace({ entry })
    } catch (error) {
      set({
        install: {
          kind: 'refused',
          id: entry.id,
          reason: 'unreachable',
          detail: error instanceof Error ? error.message : String(error)
        }
      })
      return
    }
    if (outcome.status === 'installed') {
      set({
        install: {
          kind: 'installed',
          id: entry.id,
          name: outcome.name,
          fileCount: outcome.fileCount,
          installedTo: outcome.installedTo
        }
      })
      return
    }
    set({
      install: {
        kind: 'refused',
        id: entry.id,
        reason: outcome.reason,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        ...(outcome.problematic === undefined ? {} : { problematic: outcome.problematic })
      }
    })
  }
}))

/** Test seam: forget the shelf so the next render reads it again. */
export const resetCaseMarketStore = (): void => {
  useCaseMarketStore.setState({
    shelf: { kind: 'loading' },
    install: { kind: 'idle' },
    reading: false,
    readAt: null
  })
}

export const selectIsWorking = (state: CaseMarketStore): boolean =>
  state.install.kind === 'working' || state.shelf.kind === 'loading'
