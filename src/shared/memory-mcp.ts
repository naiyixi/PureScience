// Shared identity + prompt contract for the agent-facing memory MCP server. The server lets the
// agent save a note into the user's memory during a session (the counterpart of recall injection):
// when a session reveals a fact that matches a category's save guidance, the model calls
// memory_save_note and the application owns the persistence (sanitized, deduped, bounded).

export const MEMORY_MCP_SERVER_NAME = 'purescience-memory'

export const MEMORY_SAVE_NOTE_TOOL_NAME = 'memory_save_note'

export const MEMORY_SAVE_NOTE_TOOL_DESCRIPTION =
  'Saves a note into the user\'s persistent memory, grouped under an existing category. ' +
  'Use it when the user states a durable preference, fact, or lesson about themselves or their ' +
  'work that should be remembered across sessions. Do not use it for transient task details. ' +
  'Include `evidence` (a short source note, e.g. which artifact/session the fact came from) when ' +
  'available, so the memory has provenance.'

// Rendered into the session prompt when the memory MCP is available: tells the agent WHEN to save
// (the category guidance lives in the recall block) and how (the tool, never direct file writes).
export const MEMORY_MCP_SYSTEM_PROMPT_APPEND = [
  '<purescience_memory_instructions>',
  'The user has a persistent memory. When the current session surfaces a fact that matches a ' +
    'memory category\'s save guidance (see the memory recall block), call memory_save_note with ' +
    'the exact category name and a concise note text.',
  'Save durable preferences, facts about the user\'s environment, and hard-won lessons. Do not ' +
    'save one-off task details or information already captured in project files.',
  'Never write memory files yourself. The application owns memory persistence; memory_save_note ' +
    'is the only way to add a note.',
  '</purescience_memory_instructions>'
].join('\n')
