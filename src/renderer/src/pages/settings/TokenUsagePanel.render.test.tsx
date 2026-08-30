// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { TokenUsagePanel } from './TokenUsagePanel'

let container: HTMLDivElement
let root: Root

const sessions = [
  {
    id: 's1',
    title: 'S',
    createdAt: 1000,
    updatedAt: 2000,
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'frame-root',
      activeFrameId: 'frame-root',
      frames: [
        {
          id: 'frame-root',
          kind: 'root',
          originBindingState: 'root',
          status: 'completed',
          activeBranchId: 'b1',
          createdAt: 1000
        },
        {
          id: 'frame-delegate',
          kind: 'delegate',
          parentFrameId: 'frame-root',
          agentName: 'codex',
          originBindingState: 'root',
          status: 'completed',
          activeBranchId: 'b1',
          createdAt: 1100
        }
      ],
      branches: [],
      messages: [
        {
          id: 'm1',
          parentId: null,
          agentFrameId: 'frame-root',
          role: 'human',
          content: 'go',
          createdAt: 1000
        },
        {
          id: 'm2',
          parentId: null,
          agentFrameId: 'frame-root',
          role: 'agent',
          content: 'work',
          turnUsage: { inputTokens: 100, cacheTokens: 50, outputTokens: 30 },
          createdAt: 1050
        },
        {
          id: 'm3',
          parentId: null,
          agentFrameId: 'frame-delegate',
          role: 'agent',
          content: 'sub',
          turnUsage: { inputTokens: 400, cacheTokens: 0, outputTokens: 200 },
          createdAt: 1150
        }
      ],
      activities: [],
      activityGroups: [],
      runtimeSegments: []
    },
    messages: []
  }
] as unknown as PersistedChatSession[]

beforeEach(() => {
  window.api = {
    ...(window.api ?? {}),
    getUsageRecords: vi.fn().mockResolvedValue([])
  } as unknown as typeof window.api
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

const render = (): void => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<TokenUsagePanel sessions={sessions} projects={[]} />)
  })
}

describe('TokenUsagePanel per-run section', () => {
  it('renders the per-run list with rolled-up sub-run tokens', () => {
    render()
    const list = container.querySelector('[data-slot="per-run-usage-list"]')
    expect(list).not.toBeNull()
    expect(list?.textContent).toContain('780')
    expect(list?.textContent).toContain('codex')
  })
})
