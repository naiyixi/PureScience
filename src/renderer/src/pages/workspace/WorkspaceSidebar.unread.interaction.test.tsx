// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useSessionStore } from '@/stores/session-store'
import type { ChatSession } from '@/stores/session-store'
import { WorkspaceSidebar } from './WorkspaceSidebar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const makeSession = (id: string, updatedAt: number): ChatSession => ({
  id,
  projectId: 'project-1',
  title: `Session ${id}`,
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt,
  pinned: false
})

const renderSidebar = (sessions: ChatSession[], activeSessionId?: string): HTMLElement => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <WorkspaceSidebar
        projectName="Test project"
        projects={[]}
        activeProjectId="project-a"
        onSwitchProject={() => undefined}
        sessions={sessions}
        activeSessionId={activeSessionId}
        canCreateConversation
        canMutateConversations
        canDeleteConversations
        onGoHome={() => undefined}
        onNewConversation={() => undefined}
        isFilesOpen={false}
        onOpenFiles={() => undefined}
        onOpenSession={() => undefined}
        onRenameSession={() => undefined}
        canDownloadArtifacts={false}
        onDownloadArtifacts={() => undefined}
        onViewNotebook={() => undefined}
        onTogglePin={() => undefined}
        onDeleteSession={() => undefined}
        onOpenSettings={() => undefined}
        onMobileClose={() => undefined}
      />
    )
  })
  return container
}

describe('WorkspaceSidebar unread indicator', () => {
  beforeEach(() => {
    localStorage.clear()
    useSessionStore.setState({
      sessions: [],
      selectedSessionId: undefined,
      lastReadAtBySession: {}
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('shows a New badge on sessions updated after the last read', () => {
    const container = renderSidebar([makeSession('a', 200), makeSession('b', 100)])
    // Neither session was ever opened: both are new.
    const badges = container.querySelectorAll('[aria-label="Session has new content"]')
    expect(badges.length).toBe(2)
  })

  it('hides the badge once the session is marked read', () => {
    const container = renderSidebar([makeSession('a', 200)])
    expect(container.querySelector('[aria-label="Session has new content"]')).not.toBeNull()

    act(() => {
      useSessionStore.getState().markSessionRead('a')
    })
    // Re-render with the updated store state.
    const container2 = renderSidebar([makeSession('a', 200)])
    expect(container2.querySelector('[aria-label="Session has new content"]')).toBeNull()
  })

  it('re-shows the badge when the session gets new activity after being read', () => {
    act(() => {
      useSessionStore.getState().markSessionRead('a')
    })
    const container = renderSidebar([makeSession('a', Date.now() + 1000)])
    expect(container.querySelector('[aria-label="Session has new content"]')).not.toBeNull()
  })

  it('never marks the active session as unread', () => {
    act(() => {
      useSessionStore.getState().markSessionRead('a')
    })
    const container = renderSidebar([makeSession('a', Date.now() + 1000)], 'a')
    expect(container.querySelector('[aria-label="Session has new content"]')).toBeNull()
  })
})
