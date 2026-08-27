// Renderer-side store for the user's editable memory notes (categories + notes + master switch).
// Memory is an independent feature store, deliberately OUTSIDE the settings facade: the settings
// store's facade boundary admits only load/clearSettingsWriteError, and memory is a document-shaped
// feature (whole-blob reads/writes) rather than a preference command.

import { create } from 'zustand'

import type { MemorySettings } from '../../../shared/settings'

type MemoryStoreData = {
  // The user's memory notes; undefined until the first successful load.
  memory: MemorySettings | undefined
  // Set while a read is in flight so a slow first open doesn't flash an empty panel.
  isLoading: boolean
}

type MemoryStore = MemoryStoreData & {
  // Loads memory from main; replaces the cache with the authoritative persisted shape.
  loadMemory: () => Promise<MemorySettings | undefined>
  // Persists the user's memory notes. Main sanitizes and returns the authoritative shape, which
  // replaces the cache so a corrupted write can never leave the UI showing dropped notes.
  updateMemory: (memory: MemorySettings) => Promise<void>
}

export const createInitialMemoryState = (): MemoryStoreData => ({
  memory: undefined,
  isLoading: false
})

const reportMemoryError = (action: string, error: unknown): void => {
  console.warn(`Memory ${action} failed`, error)
}

export const useMemoryStore = create<MemoryStore>((set) => ({
  ...createInitialMemoryState(),

  loadMemory: async () => {
    set({ isLoading: true })
    try {
      const memory = await window.api.settings.getMemory()
      set({ memory, isLoading: false })
      return memory
    } catch (error) {
      reportMemoryError('load', error)
      set({ isLoading: false })
      return undefined
    }
  },

  updateMemory: async (memory) => {
    try {
      const persisted = await window.api.settings.setMemory(memory)
      set({ memory: persisted })
    } catch (error) {
      reportMemoryError('save', error)
      // Re-throw so callers can surface a visible error; the store cache is untouched.
      throw error
    }
  }
}))
