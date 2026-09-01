// File-annotation repository tests: project-scoped persistence, target validation (no
// traversal), label validation, upsert-by-(target,label) replacement, and content anchoring.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationRepository, AnnotationValidationError } from './annotation-repository'

let root: string
let repository: AnnotationRepository

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'annotation-repo-'))
  repository = new AnnotationRepository({ storageRoot: root })
})

afterEach(() => {
  // tmpdir is ephemeral
})

describe('AnnotationRepository', () => {
  it('stores and lists an annotation for a project', async () => {
    const { annotation, replaced } = await repository.set(
      'project-1',
      { target: 'src/main.ts', label: 'todo', note: 'Refactor the parsing loop.' },
      'agent'
    )
    expect(replaced).toBe(false)
    expect(annotation.projectId).toBe('project-1')
    expect(annotation.targetKey).toBe('src/main.ts')
    expect(annotation.label).toBe('todo')
    expect(annotation.createdBy).toBe('agent')

    const listed = await repository.list('project-1')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.note).toBe('Refactor the parsing loop.')
  })

  it('scopes annotations per project', async () => {
    await repository.set('project-1', { target: 'a.ts', label: 'note', note: 'one' })
    await repository.set('project-2', { target: 'b.ts', label: 'note', note: 'two' })
    expect(await repository.list('project-1')).toHaveLength(1)
    expect(await repository.list('project-2')).toHaveLength(1)
  })

  it('filters by target path', async () => {
    await repository.set('project-1', { target: 'a.ts', label: 'note', note: 'one' })
    await repository.set('project-1', { target: 'b.ts', label: 'note', note: 'two' })
    const filtered = await repository.list('project-1', 'a.ts')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.targetKey).toBe('a.ts')
  })

  it('replaces the annotation for the same (target, label)', async () => {
    await repository.set('project-1', { target: 'a.ts', label: 'todo', note: 'first' })
    const { annotation, replaced } = await repository.set(
      'project-1',
      { target: 'a.ts', label: 'todo', note: 'second' },
      'user'
    )
    expect(replaced).toBe(true)
    expect(annotation.note).toBe('second')
    // Same id, same creator (first creator preserved), timestamps advanced.
    const listed = await repository.list('project-1')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.createdBy).toBe('agent')
    expect(listed[0]?.updatedAt).toBeGreaterThanOrEqual(listed[0]?.createdAt ?? 0)
  })

  it('keeps distinct labels on the same file separate', async () => {
    await repository.set('project-1', { target: 'a.ts', label: 'todo', note: 'do' })
    await repository.set('project-1', { target: 'a.ts', label: 'question', note: 'why' })
    expect(await repository.list('project-1')).toHaveLength(2)
  })

  it('anchors content checksum when provided', async () => {
    const { annotation } = await repository.set('project-1', {
      target: 'a.ts',
      label: 'review',
      note: 'checked',
      fileSha256: 'a'.repeat(64)
    })
    expect(annotation.contentChecksum).toBe('a'.repeat(64))
  })

  it('rejects absolute targets and traversal', async () => {
    await expect(
      repository.set('project-1', { target: '/etc/passwd', label: 'note', note: 'x' })
    ).rejects.toThrow(AnnotationValidationError)
    await expect(
      repository.set('project-1', { target: '../secret', label: 'note', note: 'x' })
    ).rejects.toThrow(/stay inside/)
  })

  it('rejects unknown labels and empty notes', async () => {
    await expect(
      repository.set('project-1', { target: 'a.ts', label: 'urgent' as never, note: 'x' })
    ).rejects.toThrow(/label must be one of/)
    await expect(
      repository.set('project-1', { target: 'a.ts', label: 'note', note: '   ' })
    ).rejects.toThrow(/note must not be empty/)
  })

  it('removes by id', async () => {
    const { annotation } = await repository.set('project-1', {
      target: 'a.ts',
      label: 'note',
      note: 'x'
    })
    expect(await repository.remove('project-1', annotation.id)).toBe(true)
    expect(await repository.remove('project-1', annotation.id)).toBe(false)
    expect(await repository.list('project-1')).toHaveLength(0)
  })

  it('persists across instances (file-backed)', async () => {
    await repository.set('project-1', { target: 'a.ts', label: 'note', note: 'x' })
    const reloaded = new AnnotationRepository({ storageRoot: root })
    expect(await reloaded.list('project-1')).toHaveLength(1)
  })
})
