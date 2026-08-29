// Conversational skill creation: the agent drafts a skill from natural language and installs it
// through an app-owned tool (`create_skill`). The application validates, writes the skill into the
// framework's skills directory (frontmatter + body), and owns the lifecycle — the agent never
// writes skill files itself. Bounds keep a hostile draft from overflowing or escaping the skills
// directory.

export const SKILL_CREATE_TOOL_NAME = 'create_skill'

export const SKILL_CREATE_TOOL_DESCRIPTION =
  'Creates a new reusable skill from a natural-language description. ' +
  'Use it when the user asks you to build, save, or remember a reusable procedure as a skill. ' +
  'Provide a concise name, a one-line description, and step-by-step instructions. ' +
  'The application owns skill persistence; never write skill files yourself.'

// Rendered into the session prompt when the skill MCP is available.
export const SKILL_CREATE_SYSTEM_PROMPT_APPEND = [
  '<purescience_skill_create_instructions>',
  'When the user asks you to create, save, or remember a reusable procedure as a skill, call ' +
    'create_skill with a valid name (lowercase letters, digits, hyphens, underscores; 2-64 chars), ' +
    'a one-line description, and clear step-by-step instructions in markdown.',
  'Do not write skill files yourself. The application owns skill persistence; create_skill is the ' +
    'only way to add a skill.',
  '</purescience_skill_create_instructions>'
].join('\n')

export const SKILL_CREATE_MAX_NAME_LENGTH = 64
export const SKILL_CREATE_MIN_NAME_LENGTH = 2
export const SKILL_CREATE_MAX_DESCRIPTION_LENGTH = 200
export const SKILL_CREATE_MAX_INSTRUCTIONS_LENGTH = 20_000
export const SKILL_CREATE_MAX_REFERENCES = 4
export const SKILL_CREATE_MAX_REFERENCE_LENGTH = 400

// Agent-facing tool input schema (snake_case on the wire, zod-validated at the server).
export const skillCreateToolSchema = {
  name: {
    type: 'string',
    minLength: SKILL_CREATE_MIN_NAME_LENGTH,
    maxLength: SKILL_CREATE_MAX_NAME_LENGTH,
    pattern: '^[a-z0-9_-]+$',
    description: 'Skill name: lowercase letters, digits, hyphens, underscores.'
  },
  description: {
    type: 'string',
    maxLength: SKILL_CREATE_MAX_DESCRIPTION_LENGTH,
    description: 'One-line description of what the skill does.'
  },
  instructions: {
    type: 'string',
    maxLength: SKILL_CREATE_MAX_INSTRUCTIONS_LENGTH,
    description: 'Step-by-step markdown instructions for the skill.'
  },
  references: {
    type: 'array',
    items: { type: 'string' },
    maxItems: SKILL_CREATE_MAX_REFERENCES,
    description: 'Optional reference URLs or file paths the skill depends on.'
  }
}

export const skillCreateToolDefinition = {
  title: 'Create a skill',
  description: SKILL_CREATE_TOOL_DESCRIPTION,
  inputSchema: skillCreateToolSchema
}

export type SkillCreateResult = {
  created: boolean
  skillName?: string
  path?: string
  reason?: string
}

export type SkillCreateInput = {
  name: string
  description: string
  instructions: string
  references?: string[]
}

// Validates a candidate skill name against the wire pattern. Pure so the creator and tests share it.
export const isValidSkillName = (name: string): boolean => /^[a-z0-9_-]{2,64}$/.test(name)
