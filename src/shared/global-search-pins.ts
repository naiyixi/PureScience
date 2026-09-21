import {
  GLOBAL_SEARCH_SCOPES,
  type GlobalSearchScope,
  type ReferenceTypeFilter
} from './global-search'

// A saved filter set for global search.
//
// Why it is a stored object rather than a name for "whatever the dialog had": evidence copied out of a
// search has to say which filters produced the results, and a filter that only lives in a component's state
// cannot be named by the person reading the line a week later. So a pinned set carries the filters, a name
// the user chose, and the time it was saved; applying one is what puts its name on the evidence line.

export const GLOBAL_SEARCH_PIN_SCHEMA_VERSION = 1
export const GLOBAL_SEARCH_PIN_MAX_NAME_CHARS = 80
export const GLOBAL_SEARCH_PIN_MAX_SETS = 50

export type GlobalSearchPinFilters = {
  scopes?: readonly GlobalSearchScope[]
  projectId?: string
  /** Inclusive ISO-8601 bounds, exactly as the search request takes them. */
  since?: string
  until?: string
  role?: 'user' | 'agent'
  /** Lowercase, without the dot. */
  extensions?: readonly string[]
  referenceTypes?: readonly ReferenceTypeFilter[]
}

export type GlobalSearchPin = {
  schemaVersion: typeof GLOBAL_SEARCH_PIN_SCHEMA_VERSION
  id: string
  name: string
  savedAt: string
  filters: GlobalSearchPinFilters
}

export type GlobalSearchPinValidationError =
  | 'not-an-object'
  | 'missing-id'
  | 'empty-name'
  | 'name-too-long'
  | 'missing-saved-at'
  | 'empty-filters'

export class GlobalSearchPinError extends Error {
  constructor(readonly reason: GlobalSearchPinValidationError) {
    super(`invalid search pin: ${reason}`)
    this.name = 'GlobalSearchPinError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

const scopeList = (value: unknown): GlobalSearchScope[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const scopes = value.filter(
    (item): item is GlobalSearchScope =>
      typeof item === 'string' && (GLOBAL_SEARCH_SCOPES as readonly string[]).includes(item)
  )
  return scopes.length === 0 ? undefined : [...new Set(scopes)]
}

const referenceTypeList = (value: unknown): ReferenceTypeFilter[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const known: readonly ReferenceTypeFilter[] = ['doi', 'arxiv', 'pmid', 'pmcid']
  const types = value.filter(
    (item): item is ReferenceTypeFilter =>
      typeof item === 'string' && known.includes(item as ReferenceTypeFilter)
  )
  return types.length === 0 ? undefined : [...new Set(types)]
}

const extensionList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const extensions = value
    .map((item) => (typeof item === 'string' ? item.trim().toLowerCase().replace(/^\./u, '') : ''))
    .filter((item) => item !== '')
  return extensions.length === 0 ? undefined : [...new Set(extensions)]
}

// Filters are read field by field and an unknown key is dropped rather than carried: a stored set from a
// newer build must not make an older one send a request it cannot describe.
const readFilters = (value: unknown): GlobalSearchPinFilters => {
  if (!isRecord(value)) throw new GlobalSearchPinError('not-an-object')

  const filters: GlobalSearchPinFilters = {}
  const scopes = scopeList(value.scopes)
  if (scopes) filters.scopes = scopes
  const projectId = trimmed(value.projectId)
  if (projectId) filters.projectId = projectId
  const since = trimmed(value.since)
  if (since) filters.since = since
  const until = trimmed(value.until)
  if (until) filters.until = until
  if (value.role === 'user' || value.role === 'agent') filters.role = value.role
  const extensions = extensionList(value.extensions)
  if (extensions) filters.extensions = extensions
  const referenceTypes = referenceTypeList(value.referenceTypes)
  if (referenceTypes) filters.referenceTypes = referenceTypes

  // A pin with no filters is not a filter set: it would name "everything", which is what the absence of a
  // pin already means, and it would put a meaningless name on an evidence line.
  if (Object.keys(filters).length === 0) throw new GlobalSearchPinError('empty-filters')
  return filters
}

export const sanitizeGlobalSearchPin = (value: unknown): GlobalSearchPin => {
  if (!isRecord(value)) throw new GlobalSearchPinError('not-an-object')

  const id = trimmed(value.id)
  if (!id) throw new GlobalSearchPinError('missing-id')
  const name = trimmed(value.name)
  if (!name) throw new GlobalSearchPinError('empty-name')
  if (name.length > GLOBAL_SEARCH_PIN_MAX_NAME_CHARS)
    throw new GlobalSearchPinError('name-too-long')
  const savedAt = trimmed(value.savedAt)
  if (!savedAt) throw new GlobalSearchPinError('missing-saved-at')

  return {
    schemaVersion: GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
    id,
    name,
    savedAt,
    filters: readFilters(value.filters)
  }
}

/** Sanitizes a stored list, dropping the entries that cannot be read instead of failing the whole list. */
export const sanitizeGlobalSearchPins = (value: unknown): GlobalSearchPin[] => {
  if (!Array.isArray(value)) return []
  const pins: GlobalSearchPin[] = []
  for (const entry of value.slice(0, GLOBAL_SEARCH_PIN_MAX_SETS)) {
    try {
      pins.push(sanitizeGlobalSearchPin(entry))
    } catch {
      continue
    }
  }
  return pins
}

const SCOPE_LABELS: Record<GlobalSearchScope, string> = {
  sessions: 'sessions',
  messages: 'messages',
  files: 'files',
  literature: 'literature'
}

/**
 * One machine-stable description of what a filter set accepts, in the order the request carries it. It is
 * what a pinned set is called on an evidence line, so it names only what is set and never summarizes a
 * bound away.
 */
export const describeGlobalSearchFilters = (filters: GlobalSearchPinFilters): string => {
  const parts: string[] = []
  if (filters.scopes && filters.scopes.length > 0) {
    parts.push(`scopes=${filters.scopes.map((scope) => SCOPE_LABELS[scope]).join('|')}`)
  }
  if (filters.projectId) parts.push(`project=${filters.projectId}`)
  if (filters.since) parts.push(`since=${filters.since}`)
  if (filters.until) parts.push(`until=${filters.until}`)
  if (filters.role) parts.push(`role=${filters.role}`)
  if (filters.extensions && filters.extensions.length > 0) {
    parts.push(`extensions=${filters.extensions.join('|')}`)
  }
  if (filters.referenceTypes && filters.referenceTypes.length > 0) {
    parts.push(`referenceTypes=${filters.referenceTypes.join('|')}`)
  }
  return parts.join(' ')
}
