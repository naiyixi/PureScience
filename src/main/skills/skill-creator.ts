// App-owned conversational skill creator: validates an agent-drafted skill and writes it into the
// framework skills directory as `<name>/SKILL.md` (YAML frontmatter + markdown body). The agent
// never writes skill files; the application owns persistence, bounds, and fail-closed validation.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  SKILL_CREATE_MAX_DESCRIPTION_LENGTH,
  SKILL_CREATE_MAX_EVIDENCE,
  SKILL_CREATE_MAX_EVIDENCE_LENGTH,
  SKILL_CREATE_MAX_INSTRUCTIONS_LENGTH,
  SKILL_CREATE_MAX_NAME_LENGTH,
  SKILL_CREATE_MAX_REFERENCE_LENGTH,
  SKILL_CREATE_MAX_REFERENCES,
  isValidSkillName,
  type SkillCreateInput,
  type SkillCreateResult
} from '../../shared/skill-create'
import {
  DEFAULT_SKILL_PROVENANCE,
  requiresEvidence,
  SKILL_KNOWLEDGE_KINDS,
  skillProvenanceFields,
  type SkillProvenance
} from '../../shared/skill-provenance'

const yamlQuote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`

const buildSkillDocument = (input: SkillCreateInput): string => {
  // An agent-drafted skill starts UNVERIFIED unless the caller declares otherwise: nothing has checked
  // that the procedure works (see shared/skill-provenance). Only a verified entry is reusable without
  // review, so the state has to be written down at creation time.
  const provenance = input.provenance ?? DEFAULT_SKILL_PROVENANCE
  const frontmatter = [
    '---',
    `name: ${yamlQuote(input.name.trim())}`,
    `description: ${yamlQuote(input.description.trim())}`,
    ...Object.entries(skillProvenanceFields(provenance)).map(
      ([key, value]) => `${key}: ${yamlQuote(value)}`
    ),
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

    // An explicit field wins; a caller that passes a full provenance object still gets it honoured.
    const kind = input.kind ?? input.provenance?.kind ?? 'procedure'
    if (!SKILL_KNOWLEDGE_KINDS.includes(kind)) {
      return { created: false, reason: `Unknown knowledge kind "${String(input.kind)}".` }
    }
    const evidence = (input.evidence ?? input.provenance?.evidence ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    if (evidence.length > SKILL_CREATE_MAX_EVIDENCE) {
      return { created: false, reason: 'Too many evidence items.' }
    }
    if (evidence.some((item) => item.length > SKILL_CREATE_MAX_EVIDENCE_LENGTH)) {
      return { created: false, reason: 'An evidence item is too long.' }
    }
    // A failure-mode entry is worth keeping for its reproduction, not its conclusion: refused here so
    // "this does not work" can never be recorded as knowledge on its own.
    if (requiresEvidence(kind) && evidence.length === 0) {
      return {
        created: false,
        reason:
          'Failure-mode knowledge needs evidence: give the command that fails and the error it produces.'
      }
    }

    const provenance: SkillProvenance = {
      ...(input.provenance ?? DEFAULT_SKILL_PROVENANCE),
      kind,
      evidence
    }

    const skillDir = join(this.configDir, 'skills', name)
    const document = buildSkillDocument({
      name,
      description,
      instructions,
      references,
      // Forward the declared trust state: rebuilding the input without it silently stamped every
      // skill as a fresh, unverified draft.
      provenance
    })

    try {
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, 'SKILL.md'), document, 'utf8')
    } catch (error) {
      return {
        created: false,
        reason: error instanceof Error ? error.message : 'Skill write failed.'
      }
    }

    return {
      created: true,
      skillName: name,
      path: skillDir,
      verification: provenance.verification
    }
  }
}
