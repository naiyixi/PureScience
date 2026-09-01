// Skill library reader tests: lists and reads skills from a seeded skills directory.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { SkillLibrary } from './skill-library'

let root: string
let library: SkillLibrary

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-lib-'))
  const skillsDir = join(root, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(join(skillsDir, 'alpha'), { recursive: true })
  mkdirSync(join(skillsDir, 'beta'), { recursive: true })
  mkdirSync(join(skillsDir, 'empty-dir'), { recursive: true })
  writeFileSync(
    join(skillsDir, 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: "Creates AlphaFold2 contact maps."\n---\n\n# Alpha\n\nStep one.\n'
  )
  writeFileSync(
    join(skillsDir, 'beta', 'SKILL.md'),
    '---\ndescription: Parses PDF pages.\n---\n\n# Beta\n\nStep two.\n'
  )
  library = new SkillLibrary(root)
})

describe('SkillLibrary', () => {
  it('lists skills with descriptions, skipping non-skill directories', async () => {
    const { skills } = await library.list()
    expect(skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta'])
    const alpha = skills.find((s) => s.name === 'alpha')
    expect(alpha?.description).toBe('Creates AlphaFold2 contact maps.')
  })

  it('reads a skill frontmatter and body', async () => {
    const skill = await library.read('alpha')
    expect(skill.description).toBe('Creates AlphaFold2 contact maps.')
    expect(skill.instructions).toContain('Step one.')
  })

  it('handles missing description and unquoted values', async () => {
    const skill = await library.read('beta')
    expect(skill.description).toBe('Parses PDF pages.')
    expect(skill.instructions).toContain('Step two.')
  })

  it('rejects invalid names and missing skills', async () => {
    await expect(library.read('Bad Name')).rejects.toThrow(/Invalid skill name/)
    await expect(library.read('nope')).rejects.toThrow(/No skill named/)
  })

  it('returns an empty list for a missing skills directory', async () => {
    const empty = new SkillLibrary(join(root, 'missing'))
    expect((await empty.list()).skills).toHaveLength(0)
  })
})
