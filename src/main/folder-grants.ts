// Main-process owner of user-linked folder grants (`@path/to/folder`). Grants map a stable
// rootId to an absolute directory; the agent receives only relative paths resolved against
// granted roots (see the linked-folder file-reference adapter). Persisted as a bounded JSON file
// in the data root; revoking removes the mapping so resolution immediately fails closed.

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import {
  FOLDER_GRANTS_MAX,
  FOLDER_GRANTS_MAX_PATH_LENGTH,
  type FolderGrant,
  type FolderGrantsSnapshot
} from '../shared/folder-grants'
import { isSensitiveLocalPath, validateLocalPath } from '../shared/local-fs'

export type FolderGrantsDependencies = {
  dataRoot: string
  platform?: NodeJS.Platform
}

const GRANTS_FILE = 'folder-grants.json'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sanitizeGrant = (value: unknown): FolderGrant | undefined => {
  if (!isRecord(value)) return undefined
  const rootId = typeof value.rootId === 'string' ? value.rootId : undefined
  const rootPath = typeof value.rootPath === 'string' ? value.rootPath : undefined
  const label = typeof value.label === 'string' ? value.label : undefined
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : undefined
  if (!rootId || !rootPath || !label || createdAt === undefined) return undefined
  return { rootId, rootPath, label, createdAt }
}

export class FolderGrantsService {
  private readonly dataRoot: string
  private readonly platform: NodeJS.Platform
  private grants = new Map<string, FolderGrant>()
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(deps: FolderGrantsDependencies) {
    this.dataRoot = deps.dataRoot
    this.platform = deps.platform ?? process.platform
  }

  private grantsFile(): string {
    return join(this.dataRoot, GRANTS_FILE)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.readFile(this.grantsFile(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (isRecord(parsed) && Array.isArray(parsed.grants)) {
        for (const item of parsed.grants) {
          const grant = sanitizeGrant(item)
          if (grant) this.grants.set(grant.rootId, grant)
        }
      }
    } catch {
      // Missing/corrupt grant file = no grants (fail closed).
    }
  }

  private persist(): void {
    const snapshot: FolderGrantsSnapshot = { grants: [...this.grants.values()] }
    const payload = JSON.stringify(snapshot, null, 2)
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(this.dataRoot, { recursive: true })
      await fs.writeFile(this.grantsFile(), payload, 'utf8')
    })
  }

  async list(): Promise<FolderGrantsSnapshot> {
    await this.ensureLoaded()
    return { grants: [...this.grants.values()].sort((a, b) => a.createdAt - b.createdAt) }
  }

  // Grants read access to an absolute directory. Rejects sensitive roots, oversize paths, and
  // over-capacity registries. Returns the existing grant when the same path was already granted.
  async grant(path: string): Promise<FolderGrant> {
    await this.ensureLoaded()
    const candidate = path.trim()
    if (!candidate || candidate.length > FOLDER_GRANTS_MAX_PATH_LENGTH) {
      throw new Error('Folder path is empty or too long.')
    }
    const absolute = resolve(candidate)
    // validateLocalPath returns undefined when the path is valid (an error string otherwise).
    if (
      validateLocalPath(absolute, this.platform) !== undefined ||
      isSensitiveLocalPath(absolute, this.platform)
    ) {
      throw new Error('This path is not grantable (sensitive or invalid location).')
    }
    const existing = [...this.grants.values()].find((grant) => grant.rootPath === absolute)
    if (existing) return existing
    if (this.grants.size >= FOLDER_GRANTS_MAX) {
      throw new Error(`A maximum of ${FOLDER_GRANTS_MAX} linked folders is supported.`)
    }
    const grant: FolderGrant = {
      rootId: randomUUID(),
      rootPath: absolute,
      label: basename(absolute) || absolute,
      createdAt: Date.now()
    }
    this.grants.set(grant.rootId, grant)
    this.persist()
    return grant
  }

  async revoke(rootId: string): Promise<boolean> {
    await this.ensureLoaded()
    const removed = this.grants.delete(rootId)
    if (removed) this.persist()
    return removed
  }

  // Resolves a granted root id to its absolute path, or undefined when revoked/unknown.
  // Resolution is the single trust boundary for the linked-folder reference adapter.
  async resolveRoot(rootId: string): Promise<string | undefined> {
    await this.ensureLoaded()
    return this.grants.get(rootId)?.rootPath
  }

  async shutdown(): Promise<void> {
    await this.writeChain
  }
}
