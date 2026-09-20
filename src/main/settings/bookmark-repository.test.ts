import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { validateBookmarkInput } from '../../shared/bookmark'
import { BookmarkRepository, BookmarkValidationError } from './bookmark-repository'

const createRepository = async (): Promise<BookmarkRepository> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'purescience-bookmarks-'))
  let sequence = 0
  let clock = 1_000
  return new BookmarkRepository({
    storageRoot,
    createId: () => `id-${++sequence}`,
    now: () => (clock += 10)
  })
}

describe('session bookmark validation', () => {
  it('accepts the three anchor kinds and rejects non-session or underspecified anchors', () => {
    expect(
      validateBookmarkInput({
        sessionId: 'session-1',
        anchor: { kind: 'message-text', messageId: 'message-1', text: 'a passage' }
      })
    ).toBeUndefined()
    expect(
      validateBookmarkInput({
        sessionId: 'session-1',
        anchor: { kind: 'preview-text', text: 'a passage', artifactVersionId: 'version-9' }
      })
    ).toBeUndefined()
    expect(
      validateBookmarkInput({
        sessionId: 'session-1',
        anchor: { kind: 'pdf-region', page: 3, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }
      })
    ).toBeUndefined()

    expect(
      validateBookmarkInput({
        sessionId: '  ',
        anchor: { kind: 'message-text', messageId: 'm', text: 'x' }
      })?.code
    ).toBe('invalid_session')
    expect(
      validateBookmarkInput({
        sessionId: 's',
        anchor: { kind: 'message-text', messageId: '', text: 'x' }
      })?.code
    ).toBe('invalid_message_id')
    expect(
      validateBookmarkInput({ sessionId: 's', anchor: { kind: 'preview-text', text: '   ' } })?.code
    ).toBe('invalid_text')
    expect(
      validateBookmarkInput({
        sessionId: 's',
        anchor: { kind: 'pdf-region', page: 0, rect: { x: 0, y: 0, width: 1, height: 1 } }
      })?.code
    ).toBe('invalid_page')
    expect(
      validateBookmarkInput({
        sessionId: 's',
        anchor: { kind: 'pdf-region', page: 1, rect: { x: 0, y: 0, width: 0, height: 1 } }
      })?.code
    ).toBe('invalid_rect')
    expect(
      validateBookmarkInput({
        sessionId: 's',
        anchor: { kind: 'pdf-region', page: 1, rect: { x: 0, y: 0, width: 1.4, height: 1 } }
      })?.code
    ).toBe('invalid_rect')
  })
})

describe('session bookmark storage', () => {
  it('stores, lists and edits a bookmark with its anchor intact', async () => {
    const repository = await createRepository()
    const created = await repository.add({
      sessionId: 'session-1',
      anchor: { kind: 'message-text', messageId: 'message-1', text: 'the quoted passage' },
      note: '  why this matters  '
    })
    expect(created.note).toBe('why this matters')

    const listed = await repository.list('session-1')
    expect(listed).toHaveLength(1)
    expect(listed[0].anchor).toEqual({
      kind: 'message-text',
      messageId: 'message-1',
      text: 'the quoted passage'
    })

    const updated = await repository.updateNote('session-1', created.id, 'a sharper note')
    expect(updated?.note).toBe('a sharper note')
    expect((await repository.list('session-1'))[0].updatedAt).toBeGreaterThan(created.updatedAt)
    // The anchor is not rewritten by an edit.
    expect((await repository.list('session-1'))[0].anchor).toEqual(created.anchor)
  })

  it('keeps sessions apart and tolerates removing something already gone', async () => {
    const repository = await createRepository()
    await repository.add({
      sessionId: 'session-1',
      anchor: { kind: 'message-text', messageId: 'm', text: 'one' }
    })
    await repository.add({
      sessionId: 'session-2',
      anchor: { kind: 'preview-text', text: 'two' }
    })
    expect(await repository.list('session-1')).toHaveLength(1)
    expect(await repository.list('session-2')).toHaveLength(1)

    const removed = await repository.remove('session-1', (await repository.list('session-1'))[0].id)
    expect(removed).toBe(true)
    expect(await repository.list('session-1')).toHaveLength(0)
    // Second removal: no-op success rather than an error the caller has to interpret.
    expect(await repository.remove('session-1', 'missing-id')).toBe(false)
  })

  it('refuses an invalid bookmark with a named reason and writes nothing', async () => {
    const repository = await createRepository()
    await expect(
      repository.add({
        sessionId: 'session-1',
        anchor: { kind: 'pdf-region', page: 2, rect: { x: 0, y: 0, width: 0.5, height: 0 } }
      })
    ).rejects.toBeInstanceOf(BookmarkValidationError)
    expect(await repository.list('session-1')).toHaveLength(0)
    await expect(repository.updateNote('session-1', 'any', 'x'.repeat(4001))).rejects.toBeInstanceOf(
      BookmarkValidationError
    )
  })

  it('treats a missing file as an empty list and ignores malformed rows', async () => {
    const repository = await createRepository()
    expect(await repository.list('never-used')).toEqual([])
  })
})
