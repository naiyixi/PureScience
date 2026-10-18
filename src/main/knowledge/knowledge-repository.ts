import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  KnowledgeValidationError,
  type KnowledgeCopySweep,
  type KnowledgeSweepRecord,
  type KnowledgeFingerprint,
  type KnowledgeOverview,
  type KnowledgeRegistration,
  type KnowledgeSource,
  type KnowledgeStoreSnapshot
} from '../../shared/knowledge'
import { isPathInsideOrEqual } from '../storage-root'

const SOURCES_FILE = 'sources.json'
// A stored copy is named by the digest of its own bytes; anything else in the directory is not a copy.
const DIGEST_NAME = /^[0-9a-f]{64}$/

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

  /** Where the last sweep's counts are kept. Small, human-readable, and outside the copy store so it can never be
   *  mistaken for a copy. */
  private get sweepStateFile(): string {
    return join(this.root, 'knowledge', 'last-sweep.json')
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

  // Removing a source is two facts, not one: the row leaves the register, and the copy that only it referenced
  // leaves the disk. A copy still named by another source stays — two sources can hold the same bytes, and
  // dropping the file for one of them would break the other's search. What was pruned is reported, so a caller
  // does not have to guess whether the disk changed.
  async remove(sourceId: string): Promise<{ removed: KnowledgeSource; prunedContents: string[] }> {
    const snapshot = await this.load()
    const removed = snapshot.sources.find((source) => source.id === sourceId)
    if (!removed) {
      throw new KnowledgeValidationError('source-not-found', 'That source is not registered.')
    }
    const sources = snapshot.sources.filter((source) => source.id !== sourceId)
    await this.save({ sources })

    const prunedContents: string[] = []
    if (removed.kind === 'url') {
      const stillReferenced = sources.some(
        (source) => source.kind === 'url' && source.fingerprint.value === removed.fingerprint.value
      )
      if (!stillReferenced) {
        try {
          await rm(join(this.contentDir, removed.fingerprint.value), { force: true })
          prunedContents.push(removed.fingerprint.value)
        } catch {
          // A copy that will not delete is not a failed removal: the row is gone, and a stale file on disk only
          // costs space. Reported by its absence from `prunedContents`, never claimed as cleaned.
        }
      }
    }
    return { removed, prunedContents }
  }

  // Copy cleanup that does NOT depend on someone removing a source: a copy can be orphaned by anything that
  // rewrites the register (a hand-edited sources.json, a restore from backup, a crash between save and delete).
  //
  // The guard that matters: the register is read FIRST and a register that will not parse aborts the sweep with
  // nothing deleted. An unreadable register looks exactly like "nothing is referenced", and acting on that reading
  // would delete every copy in the store — turning a corrupt file into data loss.
  //
  // Counted rather than summarised, because "we deleted three" and "one would not delete" lead to different
  // actions: the buckets add up to `scanned`, so a sweep that cannot account for an entry cannot look like it did.
  async sweepContents(): Promise<KnowledgeCopySweep> {
    const snapshot = await this.load()
    const referenced = new Set(
      snapshot.sources
        .filter((source) => source.kind === 'url')
        .map((source) => source.fingerprint.value)
    )
    let entries: Dirent[]
    try {
      entries = await readdir(this.contentDir, { withFileTypes: true })
    } catch (error) {
      // No copy store at all is a real state: nothing was ever fetched, so there is nothing to sweep.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          scanned: 0,
          kept: 0,
          removed: [],
          mismatched: [],
          failed: [],
          bytesFreed: 0,
          ignored: 0
        }
      }
      throw new KnowledgeValidationError(
        'copy-store-unreadable',
        'The stored copies could not be read.'
      )
    }
    let kept = 0
    let ignored = 0
    let bytesFreed = 0
    const removed: string[] = []
    const mismatched: string[] = []
    const failed: string[] = []
    for (const entry of entries) {
      // Only digest-shaped regular files are ours to delete. A file someone dropped in here is not this store's
      // copy, and a sweep that removes it would be deleting data it never wrote.
      if (!entry.isFile() || !DIGEST_NAME.test(entry.name)) {
        ignored += 1
        continue
      }
      const path = join(this.contentDir, entry.name)
      // The name is a claim about the bytes, and a sweep that only trusted the name would keep a copy whose
      // contents were edited underneath it — a search reads the file by that name and would cite text the
      // source's fingerprint never covered. So the claim is re-derived here, before anything is kept or deleted.
      let body: Buffer
      let size = 0
      try {
        body = await readFile(path)
        size = body.byteLength
      } catch {
        failed.push(entry.name)
        continue
      }
      if (fingerprintOf(body).value !== entry.name) {
        // A copy that is not the bytes its name claims can never answer truthfully, whether or not a source still
        // names it: dropping it is what lets the next query heal from the source itself.
        try {
          await rm(path, { force: true })
        } catch {
          failed.push(entry.name)
          continue
        }
        mismatched.push(entry.name)
        bytesFreed += size
        continue
      }
      if (referenced.has(entry.name)) {
        kept += 1
        continue
      }
      try {
        await rm(path, { force: true })
      } catch {
        // A copy that will not delete is named: the sweep did not clean it, and saying so is the difference
        // between "nothing was orphaned" and "one copy is still on disk".
        failed.push(entry.name)
        continue
      }
      removed.push(entry.name)
      bytesFreed += size
    }
    const outcome = {
      scanned: entries.length,
      kept,
      removed,
      mismatched,
      failed,
      bytesFreed,
      ignored
    }
    // Recorded after the sweep, never before: a record written first would claim a sweep that then threw.
    // A failed write is swallowed on purpose — the sweep did its work, and losing the note must not turn a
    // completed cleanup into an error the caller has to interpret.
    try {
      await writeFile(
        this.sweepStateFile,
        JSON.stringify({
          at: new Date().toISOString(),
          scanned: outcome.scanned,
          kept: outcome.kept,
          removed: outcome.removed.length,
          failed: outcome.failed.length,
          bytesFreed: outcome.bytesFreed,
          mismatched: outcome.mismatched.length
        } satisfies KnowledgeSweepRecord),
        'utf8'
      )
    } catch {
      // see above
    }
    return outcome
  }

  // What a session-external reader gets: the sources, plus whether the record itself could be read.
  async overview(): Promise<KnowledgeOverview> {
    const sweep = await this.readSweepRecord()
    const sweepFields = {
      ...(sweep.lastSweep ? { lastSweep: sweep.lastSweep } : {}),
      ...(sweep.unreadable ? { lastSweepUnreadable: true } : {})
    }
    try {
      return { sources: await this.list(), unreadable: false, ...sweepFields }
    } catch {
      return { sources: [], unreadable: true, ...sweepFields }
    }
  }

  /** The last sweep's own record. Three states, deliberately not two: no note at all means no sweep has run; a note
   *  that will not parse means we cannot say what the last one did. A note that will not parse is not "a sweep found
   *  nothing" — it is "we cannot say", which is why it is dropped rather than zeroed, and why the caller is told
   *  which of the two it got. */
  private async readSweepRecord(): Promise<{
    lastSweep?: KnowledgeSweepRecord
    unreadable: boolean
  }> {
    let raw: string
    try {
      raw = await readFile(this.sweepStateFile, 'utf8')
    } catch (cause) {
      // No note at all is the honest "nothing has swept yet". A note that exists but cannot be opened is not.
      const code = (cause as { code?: unknown }).code
      return { unreadable: code !== 'ENOENT' }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return { unreadable: true }
      const record = parsed as Partial<KnowledgeSweepRecord>
      if (typeof record.at !== 'string') return { unreadable: true }
      return {
        lastSweep: {
          at: record.at,
          scanned: Number(record.scanned ?? 0),
          kept: Number(record.kept ?? 0),
          removed: Number(record.removed ?? 0),
          failed: Number(record.failed ?? 0),
          bytesFreed: Number(record.bytesFreed ?? 0)
        },
        unreadable: false
      }
    } catch {
      return { unreadable: true }
    }
  }
}
