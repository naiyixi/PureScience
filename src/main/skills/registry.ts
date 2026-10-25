import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { SkillSource } from '../../shared/settings'
import { createLogger } from '../logger'
import { classifySkillLicense, type SkillLicenseStatus } from '../../shared/skill-license'
import {
  parseSkillProvenance,
  SKILL_TRUST_KEY,
  type SkillProvenance
} from '../../shared/skill-provenance'
import { parseFrontmatter } from './frontmatter'
import { resolveBundledSkillsRoot } from './resource-path'

const log = createLogger('skills')

// One bundled skill resolved from manifest + its SKILL.md. `sourceDir` is the absolute directory the
// materializer copies from; author/license/licenseStatus/thirdParty/category/requirements come from the SKILL.md
// frontmatter (may be absent). `category`/`requirements` let the materializer flag skills whose model
// tooling needs a compute backend this app does not provide.
export type BundledSkill = {
  id: string
  name: string
  description: string
  source: SkillSource
  updatedAt: string
  sourceDir: string
  compatibility?: string
  author?: string
  license?: string
  // Fail-closed commercial classification of the license (see shared/skill-license).
  licenseStatus?: SkillLicenseStatus
  thirdParty?: string
  category?: string
  requirements?: string
  // Trust state of learnt knowledge, read from the SKILL.md frontmatter (see shared/skill-provenance).
  // Absent for skills that ship with the app: those are curated, not learnt from a run.
  provenance?: SkillProvenance
}

type ManifestEntry = { id: string; name: string; source: SkillSource; updatedAt: string }

const SAFE_ID = /^[a-z0-9-]+$/

// A tree-wide fingerprint of the bundled skills that costs a walk and a `stat` per file instead of a read.
//
// Measured on the real bundle: 50 skills / 279 files / 1.4 MB is 55 ms of walking plus 408 ms of reading and
// hashing, 811 ms on a busy machine — the largest single step of a cold start. The hash cannot change unless
// a file's bytes change, and a file's bytes cannot change without changing its size or mtime, so the pairs
// below are enough to decide whether the expensive hash has to run again.
//
// Why not the directory mtime: rewriting `SKILL.md` in place does not touch its parent directory's mtime, so
// a directory-keyed cache would keep a stale compatibility hash and let materialisation skip an update. That
// exact failure was observed once already (`.catalog_stamp` matching while content had changed).
const bundledSkillSignature = async (sourceDir: string): Promise<string> => {
  const signature = createHash('sha256')
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath)
      } else if (entry.isFile()) {
        const stats = await stat(absolutePath)
        signature.update(relativePath)
        signature.update('\0')
        signature.update(`${stats.size}:${stats.mtimeMs}`)
        signature.update('\0')
      }
    }
  }
  await visit(sourceDir)
  return signature.digest('hex')
}

// Keyed by source directory, not a single slot. The signature is per directory, so a one-slot cache could
// never hit: each skill evicted the previous one, and every `list()` re-hashed the contents of every skill.
// Measured on the bundled tree (49 skills, 2.1 MB, 281 files) before this: 203 ms per pass, and the SECOND
// pass was no cheaper (260 ms) — the proof the cache was dead. docs/bench-runs/2026-10-25-skill-catalog.txt
const compatibilityCache = new Map<string, { signature: string; value: string }>()

const bundledSkillCompatibility = async (sourceDir: string): Promise<string> => {
  const signature = await bundledSkillSignature(sourceDir)
  const cached = compatibilityCache.get(sourceDir)
  if (cached?.signature === signature) return cached.value
  const hash = createHash('sha256')
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath)
      } else if (entry.isFile()) {
        hash.update(relativePath)
        hash.update('\0')
        hash.update(await readFile(absolutePath))
        hash.update('\0')
      }
    }
  }
  await visit(sourceDir)
  const value = `sha256:${hash.digest('hex')}`
  compatibilityCache.set(sourceDir, { signature, value })
  return value
}

/** Test seam: the module-level memo has to be resettable to prove a content change re-hashes. */
const resetBundledSkillCompatibilityCache = (): void => {
  compatibilityCache.clear()
}

// Reads and validates the manifest, dropping malformed entries.
const readManifest = async (rootDir: string): Promise<ManifestEntry[]> => {
  try {
    const raw = await readFile(join(rootDir, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as { skills?: unknown }).skills)
    ) {
      return []
    }

    return (parsed as { skills: unknown[] }).skills.filter((entry): entry is ManifestEntry => {
      const record = entry as Record<string, unknown>
      return (
        typeof record?.id === 'string' &&
        SAFE_ID.test(record.id) &&
        typeof record?.name === 'string' &&
        record?.source === 'featured' &&
        typeof record?.updatedAt === 'string'
      )
    })
  } catch {
    return []
  }
}

// Reads bundled skills shipped with the app. Malformed/missing entries are skipped, never thrown, so a
// single bad skill can never break the panel or block an agent spawn. The bundled-skills root is
// resolved lazily on first read so constructing a registry never touches electron (safe under tests).
class SkillRegistry {
  private readonly explicitRootDir?: string

  constructor(rootDir?: string) {
    this.explicitRootDir = rootDir
  }

  private get rootDir(): string {
    return this.explicitRootDir ?? resolveBundledSkillsRoot()
  }

  async list(): Promise<BundledSkill[]> {
    const entries = await readManifest(this.rootDir)

    // One round of I/O instead of one directory walk per skill, sequentially: each entry only reads its own
    // SKILL.md and its own directory, so the entries are independent. Order is preserved by `map`, and the
    // sort below makes manifest order irrelevant anyway.
    const resolved = await Promise.all(
      entries.map(async (entry): Promise<BundledSkill | undefined> => {
        const sourceDir = join(this.rootDir, entry.id)

        try {
          const raw = await readFile(join(sourceDir, 'SKILL.md'), 'utf8')
          const { fields } = parseFrontmatter(raw)

          return {
            id: entry.id,
            name: entry.name,
            description: fields.description ?? '',
            source: entry.source,
            updatedAt: entry.updatedAt,
            sourceDir,
            compatibility: await bundledSkillCompatibility(sourceDir),
            author: fields.author,
            license: fields.license,
            licenseStatus: classifySkillLicense({
              license: fields.license,
              commercialUse: fields['commercial-use'] ?? fields.commercial_use
            }),
            // The "Third-party software, content, terms, and information" row; several key spellings.
            thirdParty: fields['third-party'] ?? fields['third_party'] ?? fields.thirdparty,
            category: fields.category,
            requirements: fields.requirements,
            // Only present when the entry declares a trust state. Bundled/curated skills have none, which
            // is different from an agent draft that has not been verified yet.
            ...(fields[SKILL_TRUST_KEY] ? { provenance: parseSkillProvenance(fields) } : {})
          }
        } catch (error) {
          log.warn('skipping bundled skill with unreadable SKILL.md', { id: entry.id, error })
          return undefined
        }
      })
    )

    const skills = resolved.filter((skill): skill is BundledSkill => skill !== undefined)
    // Featured skills always display alphabetically by name; the manifest order is not significant.
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  async body(id: string): Promise<string> {
    const raw = await readFile(join(this.rootDir, id, 'SKILL.md'), 'utf8')

    return parseFrontmatter(raw).body
  }
}

export { SkillRegistry, bundledSkillCompatibility, resetBundledSkillCompatibilityCache }
