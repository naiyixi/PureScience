// Shared identity + prompt contract for the agent-facing memory MCP server. The server lets the
// agent save a note into the user's memory during a session (the counterpart of recall injection):
// when a session reveals a fact that matches a category's save guidance, the model calls
// memory_save_note and the application owns the persistence (sanitized, deduped, bounded).

export const MEMORY_MCP_SERVER_NAME = 'purescience-memory'

export const MEMORY_SAVE_NOTE_TOOL_NAME = 'memory_save_note'

// Refusal reason returned when the user's memory master switch is off. Memory is opt-in, so this is a
// user choice rather than an error — the agent's job is to surface the fact once, not to hide or
// retry it.
export const MEMORY_DISABLED_REASON = 'memory-disabled'

// The agent-facing result of a save attempt. `suggest`/`userAction` are set when the refusal is
// something the user can act on, so the model can offer the fix in one short line instead of letting
// a durable fact disappear silently (the previous behaviour: saved:false with no signal at all).
export type MemoryNoteSaveResult = {
  saved: boolean
  categoryId?: string
  noteId?: string
  reason?: string
  suggest?: 'enable-memory' | 'name-a-category'
  // Guidance the agent relays in the user's own language — kept here so every session phrases the
  // offer the same way.
  userAction?: string
}

export const MEMORY_SAVE_NOTE_TOOL_DESCRIPTION =
  "Saves a note into the user's persistent memory, grouped under an existing category. " +
  'Use it when the user states a durable preference, fact, or lesson about themselves or their ' +
  'work that should be remembered across sessions. Do not use it for transient task details. ' +
  'Include `evidence` (a short source note, e.g. which artifact/session the fact came from) when ' +
  'available, so the memory has provenance. If the save is refused because memory is turned off, ' +
  'relay that to the user in one short line — do not retry, and do not store the fact elsewhere.'

export const CHECKPOINT_SAVE_TOOL_NAME = 'checkpoint_save'

export const CHECKPOINT_SAVE_TOOL_DESCRIPTION =
  'Records durable task progress into the project checkpoint: verified facts (e.g. a resolved ' +
  'UniProt/Ensembl identifier and where it came from), installed packages, and computed outputs, ' +
  'each with source metadata. Call it after a step produces something you do not want to redo — ' +
  'the checkpoint is re-read on resume instead of re-discovering the same facts. Pass the exact ' +
  'inputs the work depended on (dataset path, tool/model version) as input_fingerprint_inputs so ' +
  'a changed input can invalidate the record instead of silently reusing stale results.'

export const CHECKPOINT_LOAD_TOOL_NAME = 'checkpoint_load'

export const CHECKPOINT_LOAD_TOOL_DESCRIPTION =
  'Loads the project task checkpoint before starting or resuming multi-step work. Returns the ' +
  'recorded facts/packages/outputs plus a freshness verdict: when the verdict is "fresh" the ' +
  'recorded work may be reused as-is (skip re-verification and re-downloads); when it is "stale" ' +
  'the inputs changed and those results must be re-verified before reuse. Pass the same inputs ' +
  'you would give checkpoint_save so freshness can be judged.'

// Rendered into the session prompt when the memory MCP is available: tells the agent WHEN to save
// (the category guidance lives in the recall block) and how (the tool, never direct file writes).
export const MEMORY_MCP_SYSTEM_PROMPT_APPEND = [
  '<purescience_memory_instructions>',
  'The user has a persistent memory. When the current session surfaces a fact that matches a ' +
    "memory category's save guidance (see the memory recall block), call memory_save_note with " +
    'the exact category name and a concise note text.',
  "Save durable preferences, facts about the user's environment, and hard-won lessons. Do not " +
    'save one-off task details or information already captured in project files.',
  'Never write memory files yourself. The application owns memory persistence; memory_save_note ' +
    'is the only way to add a note.',
  "Memory is the user's choice and can be off. If memory_save_note answers that memory is " +
    'disabled, do NOT retry and do NOT write the fact anywhere else — say one short line to the ' +
    'user that this looks worth remembering and that memory is off (Settings \u2192 Memory), so they ' +
    'can decide. Same for a category that does not exist: offer to create it instead of dropping ' +
    'the fact.',
  'For long multi-step tasks also use the project task checkpoint: checkpoint_load before ' +
    'starting or resuming (reuse fresh recorded work instead of re-running it; re-verify when the ' +
    'verdict is stale), and checkpoint_save after each durable step so a restart resumes from ' +
    'verified results rather than re-discovering them.',
  '</purescience_memory_instructions>'
].join('\n')
