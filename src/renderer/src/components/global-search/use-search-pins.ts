import { useCallback, useEffect, useMemo, useState } from 'react'

import type { TranslationKey } from '@/i18n/languages'

import {
  GLOBAL_SEARCH_PIN_MAX_SETS,
  GlobalSearchPinError,
  describeGlobalSearchFilters,
  type GlobalSearchPin,
  type GlobalSearchPinFilters
} from '../../../../shared/global-search-pins'

// Saved filter sets, as the palette uses them.
//
// The set that is "applied" is DERIVED from the filters in force rather than remembered as a click: a pin
// says which filters produced the results, so the moment a filter is changed the pin no longer describes
// what is being searched. Remembering the click would keep a name on results it did not produce, and that
// name is what a copied evidence line carries.

export type GlobalSearchContentFilters = {
  role?: 'user' | 'agent'
  extension?: string
  referenceType?: 'doi' | 'arxiv' | 'pmid' | 'pmcid'
}

const isSupportedKey = (key: string): key is 'role' | 'extensions' | 'referenceTypes' =>
  key === 'role' || key === 'extensions' || key === 'referenceTypes'

/** The filter set a pin stores for the filters in force, or undefined when nothing is set. */
export const pinFiltersForContentFilters = (
  filters: GlobalSearchContentFilters
): GlobalSearchPinFilters | undefined => {
  const pinFilters: GlobalSearchPinFilters = {}
  if (filters.role) pinFilters.role = filters.role
  if (filters.extension) pinFilters.extensions = [filters.extension]
  if (filters.referenceType) pinFilters.referenceTypes = [filters.referenceType]
  // A pin with no filters would name "everything", which is what the absence of a pin already means.
  return Object.keys(pinFilters).length === 0 ? undefined : pinFilters
}

/** The filters a stored pin puts back into the palette. Only what the palette can express is returned. */
export const contentFiltersForPin = (pin: GlobalSearchPin): GlobalSearchContentFilters => {
  const filters: GlobalSearchContentFilters = {}
  if (pin.filters.role) filters.role = pin.filters.role
  if (pin.filters.extensions?.[0]) filters.extension = pin.filters.extensions[0]
  if (pin.filters.referenceTypes?.[0]) filters.referenceType = pin.filters.referenceTypes[0]
  return filters
}

const sameFilters = (
  left: GlobalSearchContentFilters,
  right: GlobalSearchContentFilters
): boolean =>
  left.role === right.role &&
  left.extension === right.extension &&
  left.referenceType === right.referenceType

/**
 * The pin whose filters are exactly the ones in force. A pin carrying anything the palette cannot put back
 * (a scope, a project, a date bound) never matches: calling it "applied" would put its name on results that
 * came from a narrower question than the set describes.
 */
export const appliedPinFor = (
  pins: readonly GlobalSearchPin[],
  filters: GlobalSearchContentFilters
): GlobalSearchPin | undefined =>
  pins.find(
    (pin) =>
      Object.keys(pin.filters).every(isSupportedKey) &&
      Object.keys(contentFiltersForPin(pin)).length > 0 &&
      sameFilters(contentFiltersForPin(pin), filters)
  )

export type SearchPinSaveFailure = 'name-taken' | 'limit' | 'needs-filters' | 'failed'

export type SearchPinsStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'failed'; reason: SearchPinSaveFailure }

export type SearchPinsController = {
  pins: GlobalSearchPin[]
  status: SearchPinsStatus
  /** The pin that describes the filters in force, if any. */
  applied: GlobalSearchPin | undefined
  /** The attribution a capture made under `applied` carries. */
  attribution: { name: string; description: string } | undefined
  save: (name: string, filters: GlobalSearchContentFilters) => Promise<void>
  apply: (pin: GlobalSearchPin) => GlobalSearchContentFilters
  remove: (id: string) => Promise<void>
}

export const searchPinFailureLabelKey = (reason: SearchPinSaveFailure): TranslationKey => {
  switch (reason) {
    case 'name-taken':
      return 'gs.pinNameTaken'
    case 'limit':
      return 'gs.pinLimitReached'
    case 'needs-filters':
      return 'gs.pinNeedsFilters'
    default:
      return 'gs.pinSaveFailed'
  }
}

// The main process throws these; over IPC the error arrives as a plain Error with the message, so the
// message is read as well as the name — a save refused for a duplicate name must not read as a generic
// failure, because the user's only way out of it is to choose a different name.
const failureFor = (error: unknown): SearchPinSaveFailure => {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : ''
  if (name === 'PinNameConflictError' || message.includes('already uses that name'))
    return 'name-taken'
  if (name === 'PinLimitError' || message.includes('saved filter sets (have')) return 'limit'
  if (error instanceof GlobalSearchPinError) {
    return error.reason === 'empty-filters' ? 'needs-filters' : 'failed'
  }
  return 'failed'
}

export const useSearchPins = (filters: GlobalSearchContentFilters): SearchPinsController => {
  const [pins, setPins] = useState<GlobalSearchPin[]>([])
  const [status, setStatus] = useState<SearchPinsStatus>({ state: 'idle' })

  useEffect(() => {
    let current = true
    // Read through one guarded lookup: a preload without the surface (an older build, a doubled API in a
    // test) must leave the palette working with no saved sets rather than throw on open.
    const client = window.api?.searchPins
    if (!client) return
    void client
      .list()
      .then((stored) => {
        if (current) setPins(stored)
      })
      // A machine that cannot read its own saved sets has none; that is not an error the user has to clear.
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [])

  const save = useCallback(
    async (name: string, currentFilters: GlobalSearchContentFilters): Promise<void> => {
      const pinFilters = pinFiltersForContentFilters(currentFilters)
      if (!pinFilters) {
        setStatus({ state: 'failed', reason: 'needs-filters' })
        return
      }
      const client = window.api?.searchPins
      if (!client) {
        setStatus({ state: 'failed', reason: 'failed' })
        return
      }
      setStatus({ state: 'saving' })
      try {
        const saved = await client.save({ name, filters: pinFilters })
        setPins((existing) => {
          const withoutSaved = existing.filter((pin) => pin.id !== saved.id)
          return [...withoutSaved, saved].slice(0, GLOBAL_SEARCH_PIN_MAX_SETS)
        })
        setStatus({ state: 'saved' })
      } catch (error) {
        setStatus({ state: 'failed', reason: failureFor(error) })
      }
    },
    []
  )

  const remove = useCallback(async (id: string): Promise<void> => {
    try {
      await window.api?.searchPins?.remove(id)
    } finally {
      setPins((existing) => existing.filter((pin) => pin.id !== id))
    }
  }, [])

  const applied = useMemo(() => appliedPinFor(pins, filters), [pins, filters])

  const apply = useCallback((pin: GlobalSearchPin): GlobalSearchContentFilters => {
    setStatus({ state: 'idle' })
    return contentFiltersForPin(pin)
  }, [])

  const attribution = useMemo(
    () =>
      applied
        ? { name: applied.name, description: describeGlobalSearchFilters(applied.filters) }
        : undefined,
    [applied]
  )

  return { pins, status, applied, attribution, save, apply, remove }
}
