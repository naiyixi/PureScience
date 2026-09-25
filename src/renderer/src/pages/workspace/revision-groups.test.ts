import { describe, expect, it } from 'vitest'

import { groupRevisionsByRoot, type RevisionCandidate } from './revision-groups'

const message = (
  id: string,
  createdAt: number,
  root?: string,
  role = 'user'
): RevisionCandidate => ({
  id,
  createdAt,
  role,
  ...(root ? { revisionRootMessageId: root } : {})
})

describe('revision grouping', () => {
  it('groups by root in transcript order', () => {
    const grouped = groupRevisionsByRoot([
      message('b', 20, 'root-1'),
      message('a', 10, 'root-1'),
      message('c', 5, 'root-2')
    ])

    expect([...grouped.keys()].sort()).toEqual(['root-1', 'root-2'])
    expect(grouped.get('root-1')?.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(grouped.get('root-2')?.map((entry) => entry.id)).toEqual(['c'])
  })

  it('ignores messages that are not user turns or carry no root', () => {
    const grouped = groupRevisionsByRoot([
      message('assistant', 1, 'root-1', 'agent'),
      message('plain', 2)
    ])

    expect(grouped.size).toBe(0)
  })

  it('hands back the same array instance when a bucket did not change', () => {
    // The store keeps settled messages as the same instances across streaming chunks, so the rebuild sees
    // the very same objects — and the bucket identity has to survive, because that identity is what lets
    // the message item skip re-rendering.
    const settled = [message('a', 10, 'root-1'), message('b', 20, 'root-1')]
    const first = groupRevisionsByRoot(settled)
    const second = groupRevisionsByRoot(settled, first)

    expect(second.get('root-1')).toBe(first.get('root-1'))
  })

  it('rebuilds a bucket whose membership changed', () => {
    const a = message('a', 10, 'root-1')
    const first = groupRevisionsByRoot([a])
    const second = groupRevisionsByRoot([a, message('b', 20, 'root-1')], first)

    expect(second.get('root-1')).not.toBe(first.get('root-1'))
    expect(second.get('root-1')?.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('rebuilds a bucket when one of its messages was replaced', () => {
    const first = groupRevisionsByRoot([message('a', 10, 'root-1')])
    // Same id, different instance: the message was edited, so the bucket must not be reused as-is.
    const second = groupRevisionsByRoot([{ ...message('a', 10, 'root-1'), createdAt: 10 }], first)

    expect(second.get('root-1')).not.toBe(first.get('root-1'))
  })
})
