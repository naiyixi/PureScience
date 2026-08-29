// App-owned conversational skill creator: validates an agent-drafted skill and writes it into the
// framework skills directory as `<name>/SKILL.md` (YAML frontmatter + markdown body). The agent
// never writes skill files; the application owns persistence, bounds, and fail-closed validation.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  SKILL_CREATE_MAX_DESCRIPTION_LENGTH,
  SKILL_CREATE_MAX_INSTRUCTIONS_LENGTH,
  SKILL_CREATE_MAX_NAME_LENGTH,
  SKILL_CREATE_MAX_REFERENCE_LENGTH,
  SKILL_CREATE_MAX_REFERENCES,
  isValidSkillName,
  type SkillCreateInput,
  type SkillCreateResult
} from '../../shared/skill-create'

const yamlQuote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`

const buildSkillDocument = (input: SkillCreateInput): string => {
  const frontmatter = [
    '---',
    `name: ${yamlQuote(input.name.trim())}`,
    `description: ${yamlQuote(input.description.trim())}`,
    ...(input.references && input.references.length > 0
      ? [`references:\n${input.references.map((ref) => `  - ${yamlQuote(ref)}`).join('\n')}`]
      : []),
    '---',
    ''
  ].join('\n')
  return `${frontmatter}${input.instructions.trim()}\n`
}

export type SkillCreatorDependencies = {
  // Directory that contains the `skills/` subdirectory (the framework config root).
  configDir: string
}

export class SkillCreator {
  private readonly configDir: string

  constructor(deps: SkillCreatorDependencies) {
    this.configDir = deps.configDir
  }

  // Validates and persists an agent-drafted skill. Fail-closed: any bound violation or
  // malformed name returns { created: false, reason } without touching the filesystem.
  async create(input: SkillCreateInput): Promise<SkillCreateResult> {
    if (!this.configDir) {
      return { created: false, reason: 'Skill creation is not configured on this host.' }
    }
    const name = input.name?.trim() ?? ''
    const description = input.description?.trim() ?? ''
    const instructions = input.instructions?.trim() ?? ''

    if (!isValidSkillName(name)) {
      return {
        created: false,
        reason: `Invalid skill name "${name}" (lowercase letters, digits, hyphens, underscores; 2-${SKILL_CREATE_MAX_NAME_LENGTH} chars).`
      }
    }
    if (!description || description.length > SKILL_CREATE_MAX_DESCRIPTION_LENGTH) {
      return { created: false, reason: 'Skill description is missing or too long.' }
    }
    if (!instructions || instructions.length > SKILL_CREATE_MAX_INSTRUCTIONS_LENGTH) {
      return { created: false, reason: 'Skill instructions are missing or too long.' }
    }
    const references = (input.references ?? [])
      .map((ref) => ref.trim())
      .filter((ref) => ref.length > 0)
    if (references.length > SKILL_CREATE_MAX_REFERENCES) {
      return { created: false, reason: 'Too many skill references.' }
    }
    if (references.some((ref) => ref.length > SKILL_CREATE_MAX_REFERENCE_LENGTH)) {
      return { created: false, reason: 'A skill reference is too long.' }
    }

    const skillDir = join(this.configDir, 'skills', name)
    const document = buildSkillDocument({ name, description, instructions, references })

    try {
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, 'SKILL.md'), document, 'utf8')
    } catch (error) {
      return {
        created: false,
        reason: error instanceof Error ? error.message : 'Skill write failed.'
      }
    }

    return { created: true, skillName: name, path: skillDir }
  }
}
