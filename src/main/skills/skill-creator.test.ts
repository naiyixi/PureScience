import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SkillCreator } from './skill-creator'

let dir: string
let creator: SkillCreator

beforeEach(async () => {
  dir = await mkdtemp(join(homedir(), '.skill-creator-test-'))
  creator = new SkillCreator({ configDir: dir })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SkillCreator', () => {
  it('writes a valid skill document with frontmatter and body', async () => {
    const result = await creator.create({
      name: 'docking-review',
      description: 'Reviews molecular docking poses',
      instructions: '1. Load the pose file\n2. Score interactions\n3. Write a report'
    })
    expect(result.created).toBe(true)
    expect(result.skillName).toBe('docking-review')

    const doc = await readFile(join(dir, 'skills', 'docking-review', 'SKILL.md'), 'utf8')
    expect(doc).toContain('name: "docking-review"')
    expect(doc).toContain('description: "Reviews molecular docking poses"')
    expect(doc).toContain('2. Score interactions')
  })

  it('rejects invalid names without touching the filesystem', async () => {
    for (const bad of ['Bad Name', 'UPPER', 'x', 'has spaces']) {
      const result = await creator.create({
        name: bad,
        description: 'd',
        instructions: 'i'
      })
      expect(result.created).toBe(false)
    }
  })

  it('fails closed when no config dir is configured', async () => {
    const unconfigured = new SkillCreator({ configDir: '' })
    const result = await unconfigured.create({
      name: 'valid-name',
      description: 'd',
      instructions: 'i'
    })
    expect(result.created).toBe(false)
  })

  it('bounds oversize descriptions and instructions', async () => {
    const longDescription = 'x'.repeat(201)
    expect(
      (
        await creator.create({ name: 'ok-name', description: longDescription, instructions: 'i' })
      ).created
    ).toBe(false)
    const longInstructions = 'y'.repeat(20_001)
    expect(
      (await creator.create({ name: 'ok-name', description: 'd', instructions: longInstructions }))
        .created
    ).toBe(false)
  })

  it('writes optional references into the frontmatter', async () => {
    const result = await creator.create({
      name: 'with-refs',
      description: 'd',
      instructions: 'i',
      references: ['https://docs.example.com/guide']
    })
    expect(result.created).toBe(true)
    const doc = await readFile(join(dir, 'skills', 'with-refs', 'SKILL.md'), 'utf8')
    expect(doc).toContain('references:')
    expect(doc).toContain('https://docs.example.com/guide')
  })
})
