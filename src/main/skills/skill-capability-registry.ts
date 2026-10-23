// Skill capability registry: the installed skills' declared contracts, aggregated into one place so
// a caller can ask three questions without reading 50 SKILL.md files —
//   1. what does this capability need and leave behind?
//   2. which capability establishes the fact I am missing?
//   3. which skills declared nothing at all (and must therefore be reported as unchecked)?
//
// A malformed contract is kept as an error on its entry instead of aborting the scan: one bad skill
// must not make every other capability invisible.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { extractContract, type CapabilityContract } from '../../shared/capability-contract'
import {
  indexProducers,
  preflightCapability,
  type PreflightResult
} from '../../shared/capability-preflight'

// The prefix the app gives every materialized bundled skill directory. Contracts declare the bare id.
const SKILL_DIR_PREFIX = 'os-'

export type CapabilityRegistryEntry = {
  id: string
  /** Null when the skill declared no contract, or declared one that failed validation. */
  contract: CapabilityContract | null
  /** Machine-readable contract problems (see parseContractField). Empty for a clean entry. */
  errors: string[]
}

export class SkillCapabilityRegistry {
  private readonly entries = new Map<string, CapabilityRegistryEntry>()
  private producers = new Map<string, string[]>()
  private readonly roots: readonly string[]

  /**
   * One root is the normal case; several are supported because the app keeps built-in skills in the
   * RUNTIME's materialized directory (`<configRoot>/claude/skills`, `<configRoot>/opencode/...`) while
   * user-installed skills live in `<configRoot>/skills`. Reading only one of those reported "no
   * declared capabilities" on a real install even though 89 skills were installed.
   */
  constructor(
    skillsDir: string | readonly string[],
    /**
     * Contracts declared by something other than a SKILL.md — today, connector tools. A supplier
     * function (not a value) so the descriptor registry is only walked when someone actually asks.
     */
    private readonly extraContracts?: () => readonly CapabilityContract[]
  ) {
    this.roots = typeof skillsDir === 'string' ? [skillsDir] : skillsDir
  }

  /** Scans every skills root. Idempotent: a second call replaces, never appends. */
  async load(): Promise<CapabilityRegistryEntry[]> {
    const next = new Map<string, CapabilityRegistryEntry>()

    for (const root of this.roots) {
      let dirs: { name: string; isDirectory(): boolean }[] = []
      try {
        dirs = await readdir(root, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of [...dirs].sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue
        let raw: string
        try {
          raw = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8')
        } catch {
          continue // A directory without a SKILL.md is not a skill.
        }
        // The app materializes bundled skills into `os-<id>` directories, while the contract declares
        // the bare id. The parser rejects a mismatch, so passing the directory name made EVERY
        // materialized contract fail with `id_mismatch` — which is why the registry looked empty on a
        // real install. Compare against the bare id, and key the entry by it.
        const expectedId = entry.name.startsWith(SKILL_DIR_PREFIX)
          ? entry.name.slice(SKILL_DIR_PREFIX.length)
          : entry.name
        const parsed = extractContract(raw, expectedId)
        const key = parsed.contract?.id ?? expectedId
        // Same skill in two roots: keep the one that actually declares something. A materialized
        // mirror can be stripped (the ablation does exactly that), and that must not erase the
        // contract a canonical copy still carries.
        const existing = next.get(key)
        if (existing?.contract && !parsed.contract) continue
        next.set(key, { id: key, contract: parsed.contract, errors: parsed.errors })
      }
    }

    // Connector-declared contracts join the same table. A skill of the same id wins, because a skill's
    // own SKILL.md is the more specific statement about that capability.
    for (const contract of this.extraContracts?.() ?? []) {
      if (next.get(contract.id)?.contract) continue
      next.set(contract.id, { id: contract.id, contract, errors: [] })
    }

    this.entries.clear()
    for (const [id, entry] of next) this.entries.set(id, entry)
    this.producers = indexProducers(this.declared())
    return this.list()
  }

  list(): CapabilityRegistryEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  declared(): CapabilityContract[] {
    return this.list()
      .map((entry) => entry.contract)
      .filter((contract): contract is CapabilityContract => contract !== null)
  }

  /** Skill ids that declared no usable contract — the set the manifest must not hide. */
  undeclared(): string[] {
    return this.list()
      .filter((entry) => entry.contract === null)
      .map((entry) => entry.id)
  }

  /** Contract problems across the whole registry, `id: error` per line. */
  problems(): string[] {
    return this.list().flatMap((entry) => entry.errors.map((error) => `${entry.id}: ${error}`))
  }

  get(id: string): CapabilityRegistryEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * Preflight one capability against facts the session holds. Throws for an unknown capability —
   * asking about a skill that is not installed is a caller bug, not a state reading.
   */
  preflight(id: string, observed: Iterable<string>): PreflightResult {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown capability: ${id}`)
    return preflightCapability(entry.contract, observed, this.producers)
  }

  /**
   * Agent-facing manifest. Declared capabilities carry their requires/produces one line each;
   * everything else is named in the undeclared line rather than omitted, because an empty contract
   * and a satisfied contract must never look alike.
   */
  renderManifest(): string {
    const declared = this.declared()
    const undeclared = this.undeclared()
    const lines = [`capability manifest · declared ${declared.length}/${this.entries.size}`]
    for (const contract of declared) {
      const aliases = contract.aliases.length ? ` · aliases: ${contract.aliases.join(', ')}` : ''
      const requires = contract.requires.length ? contract.requires.join(', ') : '(entry point)'
      const produces = contract.produces.length ? contract.produces.join(', ') : '(none declared)'
      lines.push(`- ${contract.id}${aliases}`)
      lines.push(`  requires: ${requires}`)
      lines.push(`  produces: ${produces}`)
      if (contract.prerequisites.length) {
        lines.push(`  prerequisites: ${contract.prerequisites.join(', ')}`)
      }
    }
    if (undeclared.length) lines.push(`undeclared (${undeclared.length}): ${undeclared.join(', ')}`)
    return lines.join('\n')
  }
}
