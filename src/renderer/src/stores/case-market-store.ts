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
  | { kind: 'ready'; cases: ReadonlyArray<CaseMarketplaceEntry>; updatedAt: number }
  | {
      kind: 'refused'
      reason: 'unreachable' | 'bad-response' | 'too-large' | 'bad-index'
      detail?: string
    }
  | { kind: 'unavailable' }

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
  load: () => Promise<void>
  installCase: (entry: CaseMarketplaceEntry) => Promise<void>
}

export const useCaseMarketStore = create<CaseMarketStore>((set) => ({
  shelf: { kind: 'loading' },
  install: { kind: 'idle' },

  load: async () => {
    const api = window.api?.caseBundles?.fetchMarketplace
    // A window built without the channel simply has no shelf; it must not throw.
    if (!api) {
      set({ shelf: { kind: 'unavailable' } })
      return
    }
    set({ shelf: { kind: 'loading' } })
    const outcome = await window.api.caseBundles.fetchMarketplace({})
    set({
      shelf:
        outcome.status === 'ok'
          ? { kind: 'ready', cases: outcome.cases, updatedAt: outcome.updatedAt }
          : {
              kind: 'refused',
              reason: outcome.reason,
              ...(outcome.detail === undefined ? {} : { detail: outcome.detail })
            }
    })
  },

  installCase: async (entry) => {
    set({ install: { kind: 'working', id: entry.id } })
    const outcome = await window.api.caseBundles.installFromMarketplace({ entry })
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
  useCaseMarketStore.setState({ shelf: { kind: 'loading' }, install: { kind: 'idle' } })
}

export const selectIsWorking = (state: CaseMarketStore): boolean =>
  state.install.kind === 'working' || state.shelf.kind === 'loading'
