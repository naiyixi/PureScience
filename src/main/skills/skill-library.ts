// Skill library reader: lists and reads installed skills from the framework skills directory
// (<configDir>/skills/<name>/SKILL.md). Supports the agent's self-bootstrapping loop —
// skill_list to find overlap, skill_read to understand or verify before extending. Fail-closed
// on invalid names and missing files.

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { isValidSkillName } from '../../shared/skill-create'
import type {
  SkillLibraryEntry,
  SkillLibraryListResult,
  SkillLibraryReadResult
} from '../../shared/skill-eval'

export class SkillLibrary {
  constructor(private readonly configDir: string) {}

  // Lists every skill directory with its frontmatter description (first line).
  async list(): Promise<SkillLibraryListResult> {
    if (!this.configDir) return { skills: [] }
    let entries
    try {
      entries = await readdir(join(this.configDir, 'skills'), { withFileTypes: true })
    } catch {
      return { skills: [] }
    }
    const skills: SkillLibraryEntry[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const raw = await readFile(join(this.configDir, 'skills', entry.name, 'SKILL.md'), 'utf8')
        skills.push({
          name: entry.name,
          description: extractDescription(raw)
        })
      } catch {
        // A directory without a SKILL.md is not a skill.
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name))
    return { skills }
  }

  // Reads one skill's frontmatter + body. Throws on invalid name or missing file.
  async read(name: string): Promise<SkillLibraryReadResult> {
    const trimmed = name.trim()
    if (!isValidSkillName(trimmed)) {
      throw new Error(`Invalid skill name "${trimmed}".`)
    }
    if (!this.configDir) {
      throw new Error('Skill library is not configured on this host.')
    }
    let raw: string
    try {
      raw = await readFile(join(this.configDir, 'skills', trimmed, 'SKILL.md'), 'utf8')
    } catch {
      throw new Error(`No skill named "${trimmed}" is installed.`)
    }
    const { description, body } = splitFrontmatter(raw)
    return { name: trimmed, description, instructions: body }
  }
}

// Extracts the frontmatter `description:` value (first occurrence), defaulting to ''.
const extractDescription = (raw: string): string => {
  const { description } = splitFrontmatter(raw)
  return description.slice(0, 140)
}

// Splits a SKILL.md into frontmatter (--- … ---) and body. Best-effort: malformed frontmatter
// yields an empty description and the whole file as the body.
const splitFrontmatter = (raw: string): { description: string; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  if (!match) return { description: '', body: raw }
  const frontmatter = match[1]
  const body = raw.slice(match[0].length)
  const descriptionMatch = /^description:\s*(.+)$/m.exec(frontmatter)
  if (!descriptionMatch) return { description: '', body }
  const value = descriptionMatch[1].trim()
  const unquoted = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  return { description: unquoted, body }
}
