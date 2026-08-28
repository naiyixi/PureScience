// Memory recall: turns the user's structured memory notes (settings.memory) into a bounded system
// prompt append injected into every agent session. This is the "recall" half of the memory feature:
// when memory is enabled and a category's auto-recall is on, its notes are presented to the agent
// so preferences and facts written in one session are actually used in later ones.
//
// Deliberately bounded: per-category note cap + a hard character budget keep the memory block from
// crowding out the real task context, no matter how much the user writes over time.

import type { MemorySettings } from '../../shared/settings'

// Per-category note cap (newest first). Notes beyond this are still in the settings panel and can
// be searched, but are not auto-injected — mirroring "saved and searchable, but never auto-injected".
const NOTES_PER_CATEGORY = 20

// Hard budget for the whole injected memory block. Beyond this, the memory section is truncated
// (whole notes only) so a runaway memory can never push a session over its context budget.
const MAX_MEMORY_BLOCK_CHARS = 4000

const NOTE_CHAR_BUDGET = 600

const truncateNote = (text: string): string =>
  text.length > NOTE_CHAR_BUDGET ? `${text.slice(0, NOTE_CHAR_BUDGET).trimEnd()}…` : text

// Builds the recall instruction block, or undefined when memory is off / has nothing to recall.
// Category autoRecall: undefined behaves as on (pre-form entries keep recall), matching the
// settings sanitizer's contract.
export const renderMemoryRecallInstructions = (
  memory: MemorySettings | undefined
): string | undefined => {
  if (!memory?.enabled) return undefined

  const recallCategories = memory.categories.filter((category) => category.autoRecall !== false)
  if (recallCategories.length === 0) return undefined

  const blocks: string[] = []
  let remaining = MAX_MEMORY_BLOCK_CHARS

  for (const category of recallCategories) {
    const notes = memory.notes
      .filter((note) => note.categoryId === category.id)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, NOTES_PER_CATEGORY)
    if (notes.length === 0) continue

    const noteLines = notes
      .map((note) => `- ${truncateNote(note.text).replace(/\n+/g, ' ').trim()}`)
      .filter((line) => line.length > 2)

    const heading = `## ${category.name}`
    const block = `${heading}\n${noteLines.join('\n')}`

    // Only add the block if the heading fits; otherwise drop the whole block to avoid a dangling
    // heading. Truncation is whole-block, so the memory section never splits mid-note.
    if (remaining < heading.length) break
    if (block.length > remaining) continue
    blocks.push(block)
    remaining -= block.length + 2
  }

  if (blocks.length === 0) return undefined

  // The save guidance mirrors the settings panel's category prompts: the agent reads it to decide
  // when a session fact belongs in the user's memory (saved via the memory_save_note MCP tool).
  const saveGuidance = memory.categories
    .filter((category) => category.autoRecall !== false && category.prompt)
    .map((category) => `${category.name}: ${category.prompt}`)

  return [
    'The user keeps a persistent memory of preferences and facts about their work, written across sessions.',
    'Use these notes whenever they are relevant to the current task:',
    ...blocks,
    ...(saveGuidance.length > 0
      ? [
          "Save guidance: when the session surfaces something matching a category below, add it to the user's memory with the memory_save_note tool:",
          ...saveGuidance.map((line) => `- ${line}`)
        ]
      : [])
  ].join('\n\n')
}
