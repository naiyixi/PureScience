// Conversation annotations: user-selected context (transcript / tool activity / file preview
// text, image regions) sent to the agent as an annotation card alongside the next message.
// Annotations carry their source, are bounded, persist with the message, and survive
// edit-and-resend — the agent receives them as explicitly-cited context blocks.

export type AnnotationImageRef = {
  // Stable identifier of the source image (message image id / attachment path).
  mediaPath: string
  // Optional source pixel dimensions — informational only; regions are normalized.
  width?: number
  height?: number
}

// Normalized region (0..1 relative to the source image): x/y top-left corner + size.
export type AnnotationRegion = {
  x: number
  y: number
  width: number
  height: number
}

export type ConversationAnnotation =
  | {
      id: string
      kind: 'text'
      // Short human-readable source label, e.g. "转录" / "tool activity" / file name.
      source: string
      // The selected content. Bounded at creation time (see limits below).
      text: string
      createdAt: number
    }
  | {
      id: string
      kind: 'image'
      source: string
      // Source image reference; the region is normalized so it survives resizes.
      image: AnnotationImageRef
      region: AnnotationRegion
      createdAt: number
    }

// Hard bounds (fail closed at the renderer before staging, and at main before persistence).
export const ANNOTATION_MAX_SOURCE_LENGTH = 80
export const ANNOTATION_MAX_TEXT_LENGTH = 8_000
export const ANNOTATION_MAX_PER_MESSAGE = 8

// Smallest acceptable normalized region edge — a sub-pixel sliver carries no information.
export const ANNOTATION_MIN_REGION_EDGE = 0.02
// Regions must be fully inside the image (allow a small float tolerance).
const REGION_EPSILON = 1e-6

// Validates a normalized region: every component finite, edges within [min, 1], and the
// rect stays inside the unit square.
export const isValidAnnotationRegion = (region: unknown): region is AnnotationRegion => {
  if (!isRecord(region)) return false
  const { x, y, width, height } = region
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    ![x, y, width, height].every((value) => Number.isFinite(value))
  ) {
    return false
  }
  return (
    width >= ANNOTATION_MIN_REGION_EDGE &&
    height >= ANNOTATION_MIN_REGION_EDGE &&
    x >= -REGION_EPSILON &&
    y >= -REGION_EPSILON &&
    x + width <= 1 + REGION_EPSILON &&
    y + height <= 1 + REGION_EPSILON
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// Renders one annotation into the agent-facing prompt as a clearly-cited context block.
// The agent must treat it as user-provided context, not as an instruction source.
export const formatAnnotationPromptBlock = (annotation: ConversationAnnotation): string => {
  const source = `source="${escapeAnnotationSource(annotation.source)}"`
  if (annotation.kind === 'text') {
    return [`<annotation ${source}>`, annotation.text, '</annotation>'].join('\n')
  }
  const region = [
    annotation.region.x.toFixed(3),
    annotation.region.y.toFixed(3),
    annotation.region.width.toFixed(3),
    annotation.region.height.toFixed(3)
  ].join(',')
  return [
    `<annotation ${source} kind="image" region="${region}">`,
    `[image region annotation] source image: ${escapeAnnotationSource(annotation.image.mediaPath)}`,
    '</annotation>'
  ].join('\n')
}

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
