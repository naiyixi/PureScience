// What the knowledge store registers: where a piece of knowledge came from, and the fingerprint that lets
// anyone re-derive it later. Shared rather than owned by the store because the entry layer, the store and
// the tests must agree on one shape — two definitions would drift into a request the transport accepts and
// the store refuses.
export type KnowledgeSourceKind = 'file' | 'url'

// Size and content digest together: the digest is what a reader recomputes, the byte count is what makes a
// truncated or empty read obvious without hashing anything.
export type KnowledgeFingerprint = {
  algorithm: 'sha256'
  value: string
  bytes: number
}

export type KnowledgeSource = {
  id: string
  kind: KnowledgeSourceKind
  // A file's absolute path, or the URL exactly as it was first registered.
  location: string
  // A URL: where the request actually landed after redirects, and the title we can show a reader.
  finalUrl?: string
  // What a reader sees. For a file it is the basename; for a URL, the final URL.
  label: string
  fingerprint: KnowledgeFingerprint
  // Set when this file came in as part of a managed tree, so a folder's entries can be told apart from
  // files registered one at a time.
  folder?: string
  registeredAt: number
  updatedAt: number
}

export type KnowledgeStoreSnapshot = { sources: KnowledgeSource[] }

// What a session-external reader gets. `unreadable` is reported rather than folded into "no sources":
// "nothing was registered" and "we could not look" lead to different actions.
export type KnowledgeOverview = {
  sources: KnowledgeSource[]
  unreadable: boolean
}

export type KnowledgeRegistration =
  { kind: 'file'; path: string } | { kind: 'folder'; path: string } | { kind: 'url'; url: string }

export type KnowledgeRefusalCode =
  | 'source-outside-roots'
  | 'source-not-found'
  | 'source-not-a-file'
  | 'source-not-a-directory'
  | 'source-unreadable'
  | 'url-fetch-failed'
  | 'record-unreadable'

// A named refusal, one per reason a source cannot be registered as asked: an empty read, a redirect loop
// and a path outside the managed roots are different mistakes and the caller can act on the difference.
export class KnowledgeValidationError extends Error {
  readonly code: KnowledgeRefusalCode

  constructor(code: KnowledgeRefusalCode, message: string) {
    super(message)
    this.name = 'KnowledgeValidationError'
    this.code = code
  }
}
