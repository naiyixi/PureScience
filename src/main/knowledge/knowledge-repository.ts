import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  KnowledgeValidationError,
  type KnowledgeFingerprint,
  type KnowledgeOverview,
  type KnowledgeRegistration,
  type KnowledgeSource,
  type KnowledgeStoreSnapshot
} from '../../shared/knowledge'
import { isPathInsideOrEqual } from '../storage-root'

const SOURCES_FILE = 'sources.json'

// What a fetched URL gives the store: the body we fingerprint and where the request actually landed.
export type KnowledgeUrlReader = {
  read(url: string): Promise<{ body: string; finalUrl: string }>
}

export type KnowledgeRepositoryOptions = {
  // The data root; sources live in `<root>/knowledge/sources.json`.
  root: string
  // The managed roots a local path must sit inside. Anything else is refused by name, not normalized away.
  roots: string[]
  now?: () => number
  urlReader?: KnowledgeUrlReader
}

const fingerprintOf = (body: string | Buffer): KnowledgeFingerprint => {
  const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength
  return {
    algorithm: 'sha256',
    value: createHash('sha256').update(body).digest('hex'),
    bytes
  }
}

// The same shape as the goal store's: one writer (the main process), an atomic commit, and named refusals.
// Registration is IDEMPOTENT BY LOCATION — registering the same file or URL twice updates its fingerprint
// instead of appending a second row, because the second row would be the same source pretending to be two.
export class KnowledgeRepository {
  private readonly root: string
  private readonly roots: string[]
  private readonly now: () => number
  private readonly urlReader: KnowledgeUrlReader | undefined

  constructor(options: KnowledgeRepositoryOptions) {
    this.root = options.root
    this.roots = options.roots
    this.now = options.now ?? (() => Date.now())
    this.urlReader = options.urlReader
  }

  private get path(): string {
    return join(this.root, 'knowledge', SOURCES_FILE)
  }

  // A fetched URL's body is kept beside the register, named by its own digest. Registration is the one moment
  // the bytes are certainly in hand, so it is the moment worth spending them on: a search can then answer from
  // disk (fast, and with no network at all) instead of re-fetching every page on every query. The copy is NEVER
  // used for verification — the verifier re-fetches, because a cache that answers it only ever vouches for itself.
  private get contentDir(): string {
    return join(this.root, 'knowledge', 'contents')
  }

  private async storeUrlBody(body: string): Promise<void> {
    const path = join(this.contentDir, fingerprintOf(body).value)
    await mkdir(this.contentDir, { recursive: true })
    // Named by digest ⇒ writing the same body twice is the same write. No rotation, no clock in the name.
    await writeFile(path, body, 'utf8')
  }

  // A missing file is an empty store (nobody has registered anything yet); a file that will not parse is
  // named rather than treated as empty.
  async load(): Promise<KnowledgeStoreSnapshot> {
    const path = this.path
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sources: [] }
      throw new KnowledgeValidationError(
        'record-unreadable',
        'The source record could not be read.'
      )
    }
    try {
      const parsed = JSON.parse(raw) as { sources?: unknown }
      if (!Array.isArray(parsed.sources)) throw new Error('no sources array')
      return { sources: parsed.sources as KnowledgeSource[] }
    } catch {
      throw new KnowledgeValidationError(
        'record-unreadable',
        'The source record could not be read.'
      )
    }
  }

  private async save(snapshot: KnowledgeStoreSnapshot): Promise<void> {
    const path = this.path
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    // One rename commits it: a crash before this line leaves the previous file untouched.
    await rename(temporary, path)
  }

  // Every local path must sit inside a managed root. Refused by name: resolving a path out of bounds and
  // registering it anyway is exactly the failure this guard exists to prevent.
  private assertInsideRoots(candidate: string): void {
    if (!this.roots.some((root) => isPathInsideOrEqual(root, candidate))) {
      throw new KnowledgeValidationError(
        'source-outside-roots',
        'That location is outside the folders this workspace manages.'
      )
    }
  }

  private static upsert(
    sources: KnowledgeSource[],
    next: Omit<KnowledgeSource, 'id' | 'registeredAt' | 'updatedAt'>,
    now: number
  ): KnowledgeSource[] {
    const existing = sources.find((source) => source.location === next.location)
    const committed: KnowledgeSource = {
      ...next,
      id: existing?.id ?? randomUUID(),
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now
    }
    return existing
      ? sources.map((source) => (source.location === next.location ? committed : source))
      : [...sources, committed]
  }

  private async fileEntry(
    path: string,
    folder?: string
  ): Promise<Omit<KnowledgeSource, 'id' | 'registeredAt' | 'updatedAt'>> {
    let stats: Awaited<ReturnType<typeof stat>>
    try {
      stats = await stat(path)
    } catch {
      throw new KnowledgeValidationError('source-not-found', 'That file does not exist.')
    }
    if (!stats.isFile()) {
      throw new KnowledgeValidationError('source-not-a-file', 'That location is not a file.')
    }
    let body: Buffer
    try {
      body = await readFile(path)
    } catch {
      throw new KnowledgeValidationError('source-unreadable', 'That file could not be read.')
    }
    return {
      kind: 'file',
      location: path,
      label: basename(path),
      fingerprint: fingerprintOf(body),
      ...(folder ? { folder } : {})
    }
  }

  // Every file in the tree becomes its own entry — a folder is a way to register many sources at once, not
  // one opaque source. Nested directories are walked; nothing is followed through a symlink loop twice
  // because each path is visited once by construction.
  private async folderEntries(path: string, now: number): Promise<KnowledgeSource[]> {
    let stats: Awaited<ReturnType<typeof stat>>
    try {
      stats = await stat(path)
    } catch {
      throw new KnowledgeValidationError('source-not-found', 'That folder does not exist.')
    }
    if (!stats.isDirectory()) {
      throw new KnowledgeValidationError('source-not-a-directory', 'That location is not a folder.')
    }
    const entries: KnowledgeSource[] = []
    const walk = async (current: string): Promise<void> => {
      const children = await readdir(current, { withFileTypes: true }).catch(() => {
        throw new KnowledgeValidationError('source-unreadable', 'That folder could not be read.')
      })
      for (const child of children) {
        const childPath = join(current, child.name)
        if (child.isDirectory()) {
          await walk(childPath)
          continue
        }
        if (!child.isFile()) continue
        const entry = await this.fileEntry(childPath, path)
        entries.push({
          ...entry,
          id: randomUUID(),
          registeredAt: now,
          updatedAt: now
        })
      }
    }
    await walk(path)
    return entries
  }

  async register(request: KnowledgeRegistration): Promise<KnowledgeSource[]> {
    const now = this.now()
    const snapshot = await this.load()

    if (request.kind === 'url') {
      if (!this.urlReader) {
        throw new KnowledgeValidationError('url-fetch-failed', 'No URL reader is configured.')
      }
      let read: { body: string; finalUrl: string }
      try {
        read = await this.urlReader.read(request.url)
      } catch {
        throw new KnowledgeValidationError('url-fetch-failed', 'That URL could not be fetched.')
      }
      await this.storeUrlBody(read.body)
      const sources = KnowledgeRepository.upsert(
        snapshot.sources,
        {
          kind: 'url',
          location: request.url,
          finalUrl: read.finalUrl,
          label: read.finalUrl,
          fingerprint: fingerprintOf(read.body)
        },
        now
      )
      await this.save({ sources })
      return sources.filter((source) => source.location === request.url)
    }

    this.assertInsideRoots(request.path)
    if (request.kind === 'folder') {
      const entries = await this.folderEntries(request.path, now)
      let sources = snapshot.sources
      for (const entry of entries) {
        sources = KnowledgeRepository.upsert(sources, entry, now)
      }
      await this.save({ sources })
      return sources.filter((source) => source.folder === request.path)
    }

    const entry = await this.fileEntry(request.path)
    const sources = KnowledgeRepository.upsert(snapshot.sources, entry, now)
    await this.save({ sources })
    return sources.filter((source) => source.location === request.path)
  }

  async list(): Promise<KnowledgeSource[]> {
    const snapshot = await this.load()
    return [...snapshot.sources].sort((left, right) => left.location.localeCompare(right.location))
  }

  // What a session-external reader gets: the sources, plus whether the record itself could be read.
  async overview(): Promise<KnowledgeOverview> {
    try {
      return { sources: await this.list(), unreadable: false }
    } catch {
      return { sources: [], unreadable: true }
    }
  }
}
