// Shared identity + prompt contract for the agent-facing annotation MCP server. This is the
// "file annotations" capability: agents (or the user, via the file panel) attach lightweight
// labels + notes to files in a project. Annotations anchor to CONTENT, not just path — the
// setter may provide the file's sha256, so a later reader can tell when the file has drifted
// from what was annotated. The design mirrors the reference product's unified annotations
// table (project + target kind/key + label index + content checksum + body), adapted to the
// PureScience main-process architecture (JSON-file repository + local RPC + capability owner,
// same spine as routine/endpoint).

export const ANNOTATION_MCP_SERVER_NAME = 'purescience-annotations'

export const ANNOTATION_SET_TOOL_NAME = 'annotation_set'
export const ANNOTATION_LIST_TOOL_NAME = 'annotation_list'
export const ANNOTATION_REMOVE_TOOL_NAME = 'annotation_remove'

export const ANNOTATION_SET_TOOL_DESCRIPTION =
  'Attaches a labeled annotation (label + short note) to a file in the current project. ' +
  'target must be a path relative to the project root (e.g. "src/main.ts" or "README.md"). ' +
  'Setting the same label on the same file again replaces the previous note. Optionally pass ' +
  'file_sha256 (the file content hash) to anchor the annotation to the exact content you ' +
  'annotated — a later reader can detect drift. Labels: todo, question, important, note, review.'

export const ANNOTATION_LIST_TOOL_DESCRIPTION =
  'Lists annotations for the current project. With target, lists only that file\'s ' +
  'annotations; without, lists all annotations in the project. Each entry carries the label, ' +
  'note, content checksum (if anchored), author, and timestamps. Use it to find open todos, ' +
  'review notes, or anything flagged important before continuing work.'

export const ANNOTATION_REMOVE_TOOL_DESCRIPTION =
  'Removes one annotation by id (see annotation_list). Removing an already-missing id is a ' +
  'no-op success.'

// Predefined annotation labels (mirrors the reference label-index design; stored as strings for
// readability, ordered so the set is stable).
export const ANNOTATION_LABELS = ['todo', 'question', 'important', 'note', 'review'] as const
export type AnnotationLabel = (typeof ANNOTATION_LABELS)[number]

// Target kinds this capability supports. The reference unified annotations table is generic
// (files, transcripts, …); PureScience ships the file target first.
export const ANNOTATION_TARGET_FILE = 'file'
export type AnnotationTargetKind = typeof ANNOTATION_TARGET_FILE

export type FileAnnotation = {
  // Stable annotation identity; returned by set, referenced by remove.
  id: string
  projectId: string
  targetKind: AnnotationTargetKind
  // Path relative to the project root.
  targetKey: string
  label: AnnotationLabel
  // sha256 hex of the annotated file content (when provided at set time); null = not anchored.
  contentChecksum: string | null
  note: string
  // Who created it: a session id (agent) or 'user' (panel).
  createdBy: string
  createdAt: number
  updatedAt: number
}

export type AnnotationSetRequest = {
  // Path relative to the project root.
  target: string
  label: AnnotationLabel
  note: string
  // Optional content anchor (sha256 of the file bytes at annotation time).
  fileSha256?: string
}

export type AnnotationSetResult = {
  annotation: FileAnnotation
  // True when an existing annotation with the same (target, label) was replaced.
  replaced: boolean
}

export type AnnotationListResult = {
  annotations: FileAnnotation[]
}

export type AnnotationRemoveResult = {
  removed: boolean
}

// Rendered into the session prompt when the annotations MCP is available.
export const ANNOTATION_MCP_SYSTEM_PROMPT_APPEND = [
  '<purescience_annotation_instructions>',
  'You can attach lightweight labeled notes to files with annotation_set(target=…, label=…, ' +
    'note=…). Labels: todo, question, important, note, review. Paths are relative to the ' +
    'current project root.',
  'Use annotations as durable, low-noise memory on the files themselves: mark a section you ' +
    'need to return to (todo), flag something to verify (question), or record why a file was ' +
    'changed (note/review). Prefer an annotation over a throwaway chat message when the context ' +
    'belongs to the file.',
  'Before editing a file, annotation_list(target=…) to surface existing notes (open todos, ' +
    'review findings); honor them or update them after your edit. Pass file_sha256 when ' +
    'annotating so later readers can detect content drift.',
  'Keep notes short (a few sentences max); the body is a note, not a document.',
  '</purescience_annotation_instructions>'
].join('\n')
