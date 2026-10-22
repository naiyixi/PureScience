import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { indexProducers } from '../../shared/capability-preflight'
import { SkillCapabilityRegistry } from './skill-capability-registry'

const declared = `---
name: alpha-skill
description: "declared"
contract: '{"id":"alpha-skill","aliases":["甲技能"],"requires":["input:table"],"produces":["data:summary"],"failure_policy":{"missing_state":"Attach a table."}}'
---

# Alpha
`

const undeclared = `---
name: beta-skill
description: "no contract"
---

# Beta
`

const broken = `---
name: gamma-skill
description: "bad fact domain"
contract: '{"id":"gamma-skill","produces":["model:thing"]}'
---

# Gamma
`

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cap-registry-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const writeSkill = async (name: string, body: string): Promise<void> => {
  await mkdir(join(dir, name), { recursive: true })
  await writeFile(join(dir, name, 'SKILL.md'), body, 'utf8')
}

describe('SkillCapabilityRegistry', () => {
  it('separates declared, undeclared and broken skills without aborting the scan', async () => {
    await writeSkill('alpha-skill', declared)
    await writeSkill('beta-skill', undeclared)
    await writeSkill('gamma-skill', broken)

    const registry = new SkillCapabilityRegistry(dir)
    const entries = await registry.load()

    expect(entries.map((entry) => entry.id)).toEqual(['alpha-skill', 'beta-skill', 'gamma-skill'])
    expect(registry.declared().map((contract) => contract.id)).toEqual(['alpha-skill'])
    expect(registry.undeclared()).toEqual(['beta-skill', 'gamma-skill'])
    expect(registry.problems()).toEqual(['gamma-skill: produces_invalid_fact:model:thing'])
  })

  it('reads several roots and keeps the declared copy when a mirror was stripped', async () => {
    // User skills in the canonical root; built-ins in the runtime mirror, where the ablation blanks
    // the contract. Reading only one root was how a real install reported "nothing declared".
    await writeSkill('alpha-skill', declared)
    const mirror = join(dir, 'mirror')
    await mkdir(join(mirror, 'alpha-skill'), { recursive: true })
    await writeFile(join(mirror, 'alpha-skill', 'SKILL.md'), undeclared, 'utf8')
    await mkdir(join(mirror, 'delta-skill'), { recursive: true })
    await writeFile(
      join(mirror, 'delta-skill', 'SKILL.md'),
      declared.replace(/alpha-skill/gu, 'delta-skill'),
      'utf8'
    )

    const registry = new SkillCapabilityRegistry([dir, mirror])
    await registry.load()

    expect(registry.declared().map((contract) => contract.id)).toEqual([
      'alpha-skill',
      'delta-skill'
    ])
    expect(registry.get('alpha-skill')?.contract?.id).toBe('alpha-skill')
  })

  it('accepts a contract inside an os- prefixed materialized directory', async () => {
    // The app materializes bundled skills as `os-<id>`; the contract declares the bare id. Passing the
    // directory name as the expected id rejected every one of them with `id_mismatch`.
    const materialized = join(dir, 'os-alpha-skill')
    await mkdir(materialized, { recursive: true })
    await writeFile(join(materialized, 'SKILL.md'), declared, 'utf8')

    const registry = new SkillCapabilityRegistry(dir)
    await registry.load()

    expect(registry.declared().map((contract) => contract.id)).toEqual(['alpha-skill'])
    expect(registry.problems()).toEqual([])
    expect(registry.get('alpha-skill')?.contract).not.toBeNull()
  })

  it('preflights a capability against held facts and refuses an unknown id', async () => {
    await writeSkill('alpha-skill', declared)
    const registry = new SkillCapabilityRegistry(dir)
    await registry.load()

    expect(registry.preflight('alpha-skill', ['input:table']).status).toBe('ready')
    expect(registry.preflight('alpha-skill', []).missing).toEqual([
      { fact: 'input:table', producers: [] }
    ])
    expect(() => registry.preflight('nope', [])).toThrow('Unknown capability: nope')
  })

  it('names undeclared skills in the manifest instead of leaving them out', async () => {
    await writeSkill('alpha-skill', declared)
    await writeSkill('beta-skill', undeclared)
    const registry = new SkillCapabilityRegistry(dir)
    await registry.load()

    const manifest = registry.renderManifest()
    expect(manifest).toContain('capability manifest · declared 1/2')
    expect(manifest).toContain('requires: input:table')
    expect(manifest).toContain('produces: data:summary')
    expect(manifest).toContain('undeclared (1): beta-skill')
  })

  it('is idempotent and tolerates a missing directory', async () => {
    await writeSkill('alpha-skill', declared)
    const registry = new SkillCapabilityRegistry(dir)
    await registry.load()
    await registry.load()
    expect(registry.list()).toHaveLength(1)

    const empty = new SkillCapabilityRegistry(join(dir, 'not-there'))
    expect(await empty.load()).toEqual([])
  })
})

// The shipped skills are the product's own capability surface: a contract there must be valid, must
// match its directory, and must not require a produced fact that nothing in the registry produces.
describe('shipped skills', () => {
  const shippedDir = join(process.cwd(), 'resources', 'skills')

  it('declares only valid contracts, and every non-input requirement has a producer', async () => {
    const registry = new SkillCapabilityRegistry(shippedDir)
    const entries = await registry.load()

    expect(entries.length).toBeGreaterThanOrEqual(40)
    expect(registry.problems()).toEqual([])

    const declaredContracts = registry.declared()
    expect(declaredContracts.length).toBeGreaterThanOrEqual(7)

    const producers = indexProducers(declaredContracts)
    const dangling: string[] = []
    for (const contract of declaredContracts) {
      for (const fact of contract.requires) {
        if (fact.startsWith('input:')) continue // supplied by the user, nobody has to produce it
        if (!producers.get(fact)?.length) dangling.push(`${contract.id}: ${fact}`)
      }
    }
    expect(dangling).toEqual([])
  })

  it('gives every declared capability at least one alias', async () => {
    const registry = new SkillCapabilityRegistry(shippedDir)
    await registry.load()
    const missing = registry
      .declared()
      .filter((contract) => contract.aliases.length === 0)
      .map((contract) => contract.id)
    expect(missing).toEqual([])
  })
})
