import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  GLOBAL_SEARCH_PIN_MAX_SETS,
  GlobalSearchPinError,
  sanitizeGlobalSearchPin,
  sanitizeGlobalSearchPins,
  type GlobalSearchPin,
  type GlobalSearchPinFilters,
  type GlobalSearchPinValidationError
} from '../../shared/global-search-pins'

// Saved search filter sets for this machine.
//
// One JSON file, read tolerantly (an unreadable file means "none saved yet", never an error the user has to
// clear) and written only after the entry has passed the shared sanitizer, so what is stored is what the
// search request can actually carry.

const SEARCH_PINS_FILE = 'search-pins.json'

export type SearchPinSaveInput = {
  /** Absent creates a new set; present replaces that set's name and filters. */
  id?: string
  name: string
  filters: GlobalSearchPinFilters
}

export type SearchPinRepositoryOptions = {
  storageRoot: string
  createId?: () => string
  now?: () => number
}

export class SearchPinRepository {
  private readonly createId: () => string
  private readonly now: () => number

  constructor(private readonly options: SearchPinRepositoryOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
  }

  private get pinsPath(): string {
    return join(this.options.storageRoot, SEARCH_PINS_FILE)
  }

  async list(): Promise<GlobalSearchPin[]> {
    try {
      const parsed = JSON.parse(await readFile(this.pinsPath, 'utf8')) as unknown
      return sanitizeGlobalSearchPins(parsed)
    } catch {
      return []
    }
  }

  /**
   * Saves a filter set. The name has to be unique because the name is what an evidence line carries: two
   * sets called the same thing would make a copied line ambiguous about which filters produced it.
   */
  async save(input: SearchPinSaveInput): Promise<GlobalSearchPin> {
    const pins = await this.list()
    const existing = input.id === undefined ? undefined : pins.find((pin) => pin.id === input.id)
    if (input.id !== undefined && existing === undefined) {
      throw new GlobalSearchPinError('missing-id')
    }

    // Validate through the shared sanitizer, so an empty filter set or a nameless entry is refused here for
    // the same reason it would be refused on the way back in.
    const candidate = sanitizeGlobalSearchPin({
      id: existing?.id ?? this.createId(),
      name: input.name,
      savedAt: new Date(this.now()).toISOString(),
      filters: input.filters
    })

    const duplicate = pins.find(
      (pin) => pin.id !== candidate.id && pin.name.toLowerCase() === candidate.name.toLowerCase()
    )
    if (duplicate) {
      throw new PinNameConflictError(duplicate.id)
    }
    if (existing === undefined && pins.length >= GLOBAL_SEARCH_PIN_MAX_SETS) {
      throw new PinLimitError(pins.length)
    }

    const next = existing
      ? pins.map((pin) => (pin.id === candidate.id ? candidate : pin))
      : [...pins, candidate]
    await this.write(next)
    return candidate
  }

  async remove(id: string): Promise<boolean> {
    const pins = await this.list()
    const next = pins.filter((pin) => pin.id !== id)
    if (next.length === pins.length) return false
    await this.write(next)
    return true
  }

  private async write(pins: readonly GlobalSearchPin[]): Promise<void> {
    const path = this.pinsPath
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(pins, null, 2)}\n`, 'utf8')
  }
}

/** A name already in use: refused with the id of the set holding it, so the UI can offer to replace it. */
export class PinNameConflictError extends Error {
  constructor(readonly existingId: string) {
    super('a saved filter set already uses that name')
    this.name = 'PinNameConflictError'
  }
}

export class PinLimitError extends Error {
  constructor(readonly count: number) {
    super(`at most ${GLOBAL_SEARCH_PIN_MAX_SETS} saved filter sets (have ${count})`)
    this.name = 'PinLimitError'
  }
}

export type { GlobalSearchPinValidationError }
