// File-annotation persistence: the store behind annotation_set / annotation_list /
// annotation_remove and the file panel. Annotations are PROJECT-scoped (a note on a file in a
// project), stored as one JSON file per project under the data root (same pattern as routines
// and endpoints; the main process is the single writer, atomic temp-file + rename writes).
// One annotation per (target, label) — re-setting the same label on the same file replaces the
// previous note, mirroring the reference design's label-indexed annotation rows.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  AnnotationLabel,
  AnnotationSetRequest,
  FileAnnotation
} from '../../shared/annotation'
import { ANNOTATION_LABELS, ANNOTATION_TARGET_FILE } from '../../shared/annotation'

const ANNOTATIONS_DIR = '.annotations'
const MAX_NOTE_LENGTH = 4000

export class AnnotationValidationError extends Error {
  readonly code: 'invalid_target' | 'invalid_label' | 'invalid_note' | 'target_escapes_project'

  constructor(code: AnnotationValidationError['code'], message: string) {
    super(message)
    this.name = 'AnnotationValidationError'
    this.code = code
  }
}

export type AnnotationRepositoryOptions = {
  storageRoot: string
  createId?: () => string
  now?: () => number
}

export class AnnotationRepository {
  private readonly createId: () => string
  private readonly now: () => number

  constructor(private readonly options: AnnotationRepositoryOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
  }

  private annotationsPath(projectId: string): string {
    const safeId = encodeURIComponent(projectId)
    return join(this.options.storageRoot, ANNOTATIONS_DIR, `${safeId}.json`)
  }

  private async readAnnotations(projectId: string): Promise<FileAnnotation[]> {
    try {
      const raw = await readFile(this.annotationsPath(projectId), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed.filter(isFileAnnotation)
      return []
    } catch {
      return []
    }
  }

  private async writeAnnotations(projectId: string, annotations: FileAnnotation[]): Promise<void> {
    const target = this.annotationsPath(projectId)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${this.createId()}.tmp`
    await writeFile(temp, JSON.stringify(annotations, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temp, target)
  }

  // Validates a project-relative target path: no absolute paths, no traversal above the
  // project root (the reference design keys annotations by target path — a forged "../../etc"
  // would silently annotate outside the project).
  private validateTarget(target: string): string {
    const trimmed = target.trim()
    if (!trimmed) {
      throw new AnnotationValidationError('invalid_target', 'target must not be empty')
    }
    if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
      throw new AnnotationValidationError(
        'invalid_target',
        'target must be a project-relative path (no absolute paths).'
      )
    }
    const normalized = trimmed.replace(/\\/g, '/')
    const segments = normalized.split('/')
    if (segments.some((segment) => segment === '..' || segment === '.')) {
      throw new AnnotationValidationError(
        'target_escapes_project',
        'target must stay inside the project root (no ".." or "." segments).'
      )
    }
    return normalized
  }

  private validateLabel(label: string): AnnotationLabel {
    if (!ANNOTATION_LABELS.includes(label as AnnotationLabel)) {
      throw new AnnotationValidationError(
        'invalid_label',
        `label must be one of: ${ANNOTATION_LABELS.join(', ')}`
      )
    }
    return label as AnnotationLabel
  }

  private validateNote(note: string): string {
    const trimmed = note.trim()
    if (!trimmed) {
      throw new AnnotationValidationError('invalid_note', 'note must not be empty')
    }
    if (trimmed.length > MAX_NOTE_LENGTH) {
      throw new AnnotationValidationError(
        'invalid_note',
        `note must be at most ${MAX_NOTE_LENGTH} chars`
      )
    }
    return trimmed
  }

  // Sets (or replaces) the annotation for (project, target, label). Returns the stored
  // annotation plus whether an existing one was replaced.
  async set(
    projectId: string,
    request: AnnotationSetRequest,
    createdBy = 'agent'
  ): Promise<{ annotation: FileAnnotation; replaced: boolean }> {
    const target = this.validateTarget(request.target)
    const label = this.validateLabel(request.label)
    const note = this.validateNote(request.note)
    const now = this.now()

    const annotations = await this.readAnnotations(projectId)
    const index = annotations.findIndex(
      (annotation) => annotation.targetKey === target && annotation.label === label
    )
    const replaced = index !== -1
    const previous = index >= 0 ? annotations[index] : undefined
    const annotation: FileAnnotation = {
      id: previous?.id ?? this.createId(),
      projectId,
      targetKind: ANNOTATION_TARGET_FILE,
      targetKey: target,
      label,
      contentChecksum: request.fileSha256?.trim() || previous?.contentChecksum || null,
      note,
      createdBy: previous?.createdBy ?? createdBy,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    }
    const next = replaced
      ? annotations.map((entry) => (entry === annotations[index] ? annotation : entry))
      : [...annotations, annotation]
    await this.writeAnnotations(projectId, next)
    return { annotation, replaced }
  }

  // Lists annotations for a project, optionally filtered to one target path.
  async list(projectId: string, target?: string): Promise<FileAnnotation[]> {
    const annotations = await this.readAnnotations(projectId)
    if (!target) return annotations
    const normalized = this.validateTarget(target)
    return annotations.filter((annotation) => annotation.targetKey === normalized)
  }

  // Removes one annotation by id. Returns false when it did not exist.
  async remove(projectId: string, annotationId: string): Promise<boolean> {
    const annotations = await this.readAnnotations(projectId)
    const next = annotations.filter((annotation) => annotation.id !== annotationId)
    if (next.length === annotations.length) return false
    await this.writeAnnotations(projectId, next)
    return true
  }

  // Removes every annotation for a project (project deletion path).
  async clearProject(projectId: string): Promise<void> {
    await this.writeAnnotations(projectId, [])
  }
}

const isFileAnnotation = (value: unknown): value is FileAnnotation => {
  if (typeof value !== 'object' || value === null) return false
  const annotation = value as Record<string, unknown>
  return (
    typeof annotation.id === 'string' &&
    typeof annotation.projectId === 'string' &&
    typeof annotation.targetKey === 'string' &&
    typeof annotation.label === 'string' &&
    typeof annotation.note === 'string' &&
    typeof annotation.createdAt === 'number'
  )
}
