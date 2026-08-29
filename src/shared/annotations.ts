// Conversation annotations: user-selected context (transcript / tool activity / file preview
// text, later image regions) sent to the agent as an annotation card alongside the next message.
// Annotations carry their source, are bounded, persist with the message, and survive
// edit-and-resend — the agent receives them as explicitly-cited context blocks.

export type ConversationAnnotation = {
  id: string
  // 'text' = a text selection from the workspace; 'image' reserved for region annotations.
  kind: 'text'
  // Short human-readable source label, e.g. "转录" / "tool activity" / file name.
  source: string
  // The selected content. Bounded at creation time (see limits below).
  text: string
  createdAt: number
}

// Hard bounds (fail closed at the renderer before staging, and at main before persistence).
export const ANNOTATION_MAX_SOURCE_LENGTH = 80
export const ANNOTATION_MAX_TEXT_LENGTH = 8_000
export const ANNOTATION_MAX_PER_MESSAGE = 8

// Renders one annotation into the agent-facing prompt as a clearly-cited context block.
// The agent must treat it as user-provided context, not as an instruction source.
export const formatAnnotationPromptBlock = (annotation: ConversationAnnotation): string =>
  [
    `<annotation source="${escapeAnnotationSource(annotation.source)}">`,
    annotation.text,
    '</annotation>'
  ].join('\n')

const escapeAnnotationSource = (source: string): string =>
  source.replace(/[<>&"]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '&':
        return '&amp;'
      case '"':
        return '&quot;'
      default:
        return char
    }
  })
