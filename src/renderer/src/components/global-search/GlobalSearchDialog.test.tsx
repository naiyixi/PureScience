// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LanguageProvider } from '@/i18n'
import type { ChatSession } from '@/stores/session-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'

import { GlobalSearchDialog } from './GlobalSearchDialog'

// React's act() refuses to run unless the environment opts in, and jsdom lacks the pointer and scroll
// APIs the Select primitive reaches for when it opens — the same stubs the repo's other render tests use.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

let container: HTMLDivElement
let root: Root

const artifact = {
  id: 'artifact-1',
  source: 'artifact' as const,
  sourceFileId: 'artifact-1',
  sourceVersionId: 'version-1',
  projectId: 'project-a',
  sessionId: 'session-a',
  name: 'sin.png',
  path: 'artifact-version:project-a/session-a/artifact-1/version-1',
  size: 12,
  sortAtMs: Date.now() - 3 * 24 * 60 * 60 * 1_000,
  originSession: { state: 'active' as const }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.clear()
  useProjectStore.setState({
    ...createInitialProjectState(),
    isLoaded: true,
    projects: [
      {
        id: 'project-a',
        name: 'Alpha',
        description: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 2
      },
      {
        id: 'project-b',
        name: 'Beta',
        description: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  useSessionStore.setState({
    ...createInitialSessionState(),
    selectedSessionId: 'session-a',
    sessions: [
      {
        id: 'session-a',
        projectId: 'project-a',
        title: 'Python 绘制 sin 函数图',
        cwd: '/workspace',
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        artifacts: []
      },
      {
        id: 'session-b',
        projectId: 'project-b',
        title: 'Other sin session',
        cwd: '/workspace',
        status: 'idle',
        createdAt: Date.now() - 1,
        updatedAt: Date.now() - 1,
        messages: [],
        artifacts: []
      }
    ] as ChatSession[]
  })
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project-a',
    userNavigationRevision: 0,
    explicitNavigationRevision: 0,
    pendingCustomizePrefill: undefined,
    pendingProjectCreation: false,
    pendingArtifactMention: undefined,
    artifactMentionAvailability: { projectId: 'project-a', canMention: true }
  })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      projectFiles: {
        searchArtifacts: vi.fn().mockResolvedValue({
          primary: { items: [artifact], totalCount: 1 },
          other: [],
          isIndexComplete: true
        })
      },
      search: {
        query: vi.fn().mockResolvedValue({
          schemaVersion: 1,
          query: 'sin',
          scopes: ['sessions', 'messages', 'files', 'literature'],
          hits: [],
          counts: { sessions: 0, messages: 0, files: 0, literature: 0 },
          truncated: false,
          scan: { sessions: 0, messages: 0, files: 0, references: 0, bounded: false },
          appliedLimit: 100,
          notes: []
        })
      },
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'preview-resource-1',
          url: 'purescience-preview://preview-resource-1',
          mimeType: 'image/png'
        }),
        release: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('GlobalSearchDialog', () => {
  it('hands focus back to the control that opened it when the palette closes', async () => {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    // Radix leaves pointer-events on the body after a modal closes, and jsdom then refuses to focus.
    document.body.removeAttribute('style')

    const opener = document.createElement('button')
    opener.textContent = 'open palette'
    document.body.appendChild(opener)
    opener.focus()

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    expect(document.activeElement).not.toBe(document.body)

    await act(async () => {
      root.render(
        <GlobalSearchDialog open={false} onOpenChange={vi.fn()} isSessionPersistenceReady />
      )
      await new Promise((resolve) => window.setTimeout(resolve, 40))
    })

    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('explains an empty browse list instead of leaving the results area blank', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: { items: [], totalCount: 0 },
      other: [],
      isIndexComplete: true
    })
    useSessionStore.setState({ sessions: [] })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    // Both sections were gated on length > 0, so a project with nothing to show rendered a blank
    // result area that looked exactly like a failed load.
    const empty = document.body.querySelector<HTMLElement>(
      '[data-testid="global-search-browse-empty"]'
    )
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('Nothing to browse yet')
    expect(empty?.textContent).toContain('start a conversation in the workspace')
  })

  it('keeps the browse explanation out of the way once there is something to browse', async () => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(document.body.querySelector('[data-testid="global-search-browse-empty"]')).toBeNull()
    expect(document.body.textContent).toContain('Recent sessions')
  })

  it('tells a filtered dead end apart from a query that simply found nothing', async () => {
    const query = window.api.search.query as unknown as ReturnType<typeof vi.fn>
    // Keyword artifact search keeps serving the same rows regardless of the query, so it has to be
    // emptied too: otherwise the Artifacts section alone keeps the dead end from being a dead end.
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: { items: [], totalCount: 0 },
      other: [],
      isIndexComplete: true
    })
    query.mockResolvedValue({
      schemaVersion: 1,
      query: '注意力',
      scopes: ['sessions', 'messages', 'files', 'literature'],
      hits: [],
      counts: { sessions: 0, messages: 0, files: 0, literature: 0 },
      truncated: false,
      scan: { sessions: 1, messages: 1, files: 0, references: 0, bounded: false },
      appliedLimit: 100,
      notes: []
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, '注意力')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 500))
    })

    expect(document.body.textContent).toContain('No sessions or artifacts match')
    expect(document.body.textContent).toContain('Try fewer words')
    expect(document.body.textContent).not.toContain('Filters are narrowing this search')

    const bar = document.body.querySelector('[data-testid="global-search-filters"]')
    const trigger = bar?.querySelector('button')
    await act(async () => {
      trigger?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
      )
      trigger?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 50))
    })
    const option = [...document.body.querySelectorAll('[role="option"], [role="menuitem"]')].find(
      (node) => /^(助手|Agent)$/.test(node.textContent?.trim() ?? '')
    )
    expect(option).toBeDefined()
    await act(async () => {
      ;(option as HTMLElement).click()
      await new Promise((resolve) => window.setTimeout(resolve, 500))
    })

    // Only the filtered dead end is fixable from inside the palette, so only that one says how.
    expect(document.body.textContent).toContain('Filters are narrowing this search')
    expect(document.body.textContent).not.toContain('Try fewer words')
  })

  it('shows recent groups and sends a current-Project artifact to the composer mention handoff', async () => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(document.body.textContent).toContain('Recent artifacts')
    expect(document.body.textContent).toContain('Recent sessions')
    expect(document.body.textContent).toContain('New session')
    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    expect(input?.placeholder).toBe('Search this project…')
    expect(input?.parentElement?.textContent).toContain('Alpha')
    expect(
      document.body.querySelector('[data-testid="global-search-footer"]')?.textContent
    ).toContain('mention')

    const artifactRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('sin.png')
    ) as HTMLElement
    expect(artifactRow.classList).toContain('cursor-pointer')
    expect(artifactRow.classList).toContain('select-none')
    expect(
      artifactRow.querySelector<HTMLImageElement>('img[alt="Preview of sin.png"]')
    ).not.toBeNull()
    expect(artifactRow.textContent).toContain('Python 绘制 sin 函数图 · 3 days ago')
    act(() => artifactRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    const mention = document.body.querySelector<HTMLElement>('[aria-label="Mention sin.png"]')
    expect(mention).not.toBeNull()
    act(() => mention?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject({ id: 'artifact-1' })
  })

  it('prioritizes Artifacts and selects the first Artifact for a keyword search', async () => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })

    const groupHeadings = [...document.body.querySelectorAll('[role="group"] h2')].map(
      (heading) => heading.textContent
    )
    const selectedOption = document.body.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]'
    )

    expect(groupHeadings.slice(0, 2)).toEqual(['Artifacts', 'Sessions'])
    expect(selectedOption?.textContent).toContain('sin.png')
    expect(document.body.textContent).toContain('New session')

    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-1',
      projectId: 'project-a'
    })
  })

  // The interaction the filter bar exists for: choosing a sender has to reach the search as a filter.
  it('sends the chosen sender filter with the search and offers to clear it', async () => {
    const query = window.api.search.query as unknown as ReturnType<typeof vi.fn>
    query.mockResolvedValue({
      schemaVersion: 1,
      query: '注意力',
      scopes: ['sessions', 'messages', 'files', 'literature'],
      hits: [
        {
          scope: 'messages',
          id: 'message-1',
          projectId: 'project-a',
          title: '注意力机制研究',
          score: 4,
          matches: [{ field: 'body', snippet: '…注意力机制…', offset: 0 }],
          sessionId: 'session-a',
          messageId: 'message-1',
          role: 'user'
        }
      ],
      counts: { sessions: 0, messages: 1, files: 0, literature: 0 },
      truncated: false,
      scan: { sessions: 1, messages: 1, files: 0, references: 0, bounded: false },
      appliedLimit: 100,
      notes: []
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, '注意力')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 500))
    })
    expect(query).toHaveBeenCalled()

    const bar = document.body.querySelector('[data-testid="global-search-filters"]')
    expect(bar).not.toBeNull()
    const trigger = bar?.querySelector('button')
    expect(trigger).not.toBeNull()

    await act(async () => {
      trigger?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
      )
      trigger?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 50))
    })

    const option = [...document.body.querySelectorAll('[role="option"], [role="menuitem"]')].find(
      (node) => /^(助手|Agent)$/.test(node.textContent?.trim() ?? '')
    )
    expect(option).toBeDefined()

    await act(async () => {
      ;(option as HTMLElement).click()
      await new Promise((resolve) => window.setTimeout(resolve, 500))
    })

    expect(query.mock.calls.at(-1)?.[0]).toMatchObject({ role: 'agent' })
    expect(
      document.body.querySelector('[data-testid="global-search-filters-clear"]')
    ).not.toBeNull()
  })

  it('keeps the result list scrollable and the shortcut footer outside the scroll viewport', async () => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const dialog = document.body.querySelector<HTMLElement>('[data-testid="global-search-dialog"]')
    const results = document.body.querySelector<HTMLElement>(
      '[data-testid="global-search-results"]'
    )
    const footer = document.body.querySelector<HTMLElement>('[data-testid="global-search-footer"]')
    const input = dialog?.querySelector<HTMLInputElement>('input[role="combobox"]')
    const searchHeader = input?.parentElement

    expect(dialog?.classList).toContain('h-[calc(100dvh_-_1rem)]')
    expect(input?.classList).toContain('focus-visible:ring-0')
    expect(input?.classList).not.toContain('focus-visible:outline-ring')
    expect(searchHeader?.classList).not.toContain('focus-within:ring-[3px]')
    expect(searchHeader?.classList).not.toContain('focus-within:ring-inset')
    expect(results?.classList).toContain('min-h-0')
    expect(results?.classList).toContain('flex-1')
    expect(footer?.classList).toContain('shrink-0')
    expect(footer?.classList).toContain('grid-cols-2')
    expect(footer?.querySelectorAll('kbd')).toHaveLength(4)
    expect(results?.contains(footer ?? null)).toBe(false)
  })

  it('closes with Escape when an artifact row action holds focus', async () => {
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const artifactRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('sin.png')
    ) as HTMLElement
    act(() => artifactRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    const mention = document.body.querySelector<HTMLButtonElement>('[aria-label="Mention sin.png"]')
    mention?.focus()

    await act(async () => {
      mention?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens the active Artifact on Shift+Enter when no Session is active', async () => {
    window.localStorage.setItem('purescience:last-opened-project', 'project-a')
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-1',
      projectId: 'project-a'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens the active Artifact on Shift+Enter from a Project draft without a Session', async () => {
    useSessionStore.setState({ selectedSessionId: undefined })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-1',
      projectId: 'project-a'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('mentions the active Artifact on Shift+Enter inside the current Session', async () => {
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject({
      id: 'artifact-1',
      projectId: 'project-a'
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens the active Artifact on Shift+Enter when the current Session cannot accept a mention', async () => {
    useNavigationStore.setState({
      artifactMentionAvailability: { projectId: 'project-a', canMention: false }
    })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-1',
      projectId: 'project-a'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens a cross-Project Artifact on Shift+Enter instead of mentioning it', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: { items: [], totalCount: 0 },
      other: [
        {
          ...artifact,
          id: 'artifact-2',
          sourceFileId: 'artifact-2',
          sourceVersionId: 'version-2',
          projectId: 'project-b',
          sessionId: 'session-b',
          name: 'other.png',
          path: 'artifact-version:project-b/session-b/artifact-2/version-2'
        }
      ],
      isIndexComplete: true
    })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'other.png')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: 'project-b',
      pendingArtifactMention: undefined
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-2',
      projectId: 'project-b'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('uses the source message creation time for a legacy artifact', async () => {
    const createdAt = Date.now() - 4 * 24 * 60 * 60 * 1_000
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-a'
          ? {
              ...session,
              messages: [
                {
                  id: 'message-a',
                  role: 'agent',
                  content: 'Created legacy artifact',
                  status: 'complete',
                  eventIds: [],
                  artifactIds: ['artifact-1'],
                  createdAt,
                  updatedAt: Date.now()
                }
              ]
            }
          : session
      )
    }))
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValueOnce({
      primary: {
        items: [
          {
            ...artifact,
            sourceVersionId: undefined,
            messageId: 'message-a',
            path: '/workspace/sin.png',
            sortAtMs: Date.now()
          }
        ],
        totalCount: 1
      },
      other: [],
      isIndexComplete: true
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const artifactRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('sin.png')
    )
    expect(artifactRow?.textContent).toContain('Python 绘制 sin 函数图 · 4 days ago')
  })

  it('disables the current-Project mention action when the composer cannot accept another Artifact', async () => {
    useNavigationStore.setState({
      artifactMentionAvailability: { projectId: 'project-a', canMention: false }
    })
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const artifactRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('sin.png')
    ) as HTMLElement
    act(() => artifactRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    const mention = document.body.querySelector<HTMLButtonElement>('[aria-label="Mention sin.png"]')
    expect(mention?.disabled).toBe(true)
    act(() => mention?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
  })

  it('limits Other projects to five mixed Session and Artifact results', async () => {
    const now = Date.now()
    useSessionStore.setState((state) => ({
      sessions: [
        ...state.sessions,
        ...Array.from({ length: 5 }, (_, index) => ({
          ...state.sessions[1],
          id: `other-session-${index}`,
          title: `Other sin ${index}`,
          updatedAt: now - (index + 1) * 20
        }))
      ] as ChatSession[]
    }))
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: { items: [artifact], totalCount: 1 },
      other: Array.from({ length: 3 }, (_, index) => ({
        ...artifact,
        id: `other-artifact-${index}`,
        sourceFileId: `other-artifact-${index}`,
        sourceVersionId: `other-version-${index}`,
        projectId: 'project-b',
        sessionId: 'session-b',
        name: `other-sin-${index}.png`,
        path: `artifact-version:project-b/session-b/other-artifact-${index}/other-version-${index}`,
        sortAtMs: now - index * 30
      })),
      isIndexComplete: true
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })

    const otherGroup = document.body.querySelector<HTMLElement>(
      '[role="group"][aria-label="Other projects"]'
    )
    expect(otherGroup?.querySelectorAll('[role="option"]')).toHaveLength(5)
    expect(otherGroup?.textContent).toContain('other-sin-0.png')
    expect(otherGroup?.textContent).toContain('Other sin session')
  })

  it('uses the global Home context and offers New Project without mention', async () => {
    window.localStorage.setItem('purescience:last-opened-project', 'project-b')
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const footer = document.body.querySelector<HTMLElement>('[data-testid="global-search-footer"]')
    expect(input?.placeholder).toBe('Search sessions and artifacts…')
    expect(input?.parentElement?.textContent).not.toContain('Beta')
    expect(footer?.textContent).not.toContain('mention')
    expect(footer?.querySelectorAll('kbd')).toHaveLength(3)
    expect(window.api.projectFiles.searchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ primaryProjectId: 'project-b', otherLimit: 5 })
    )

    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })
    expect(document.body.querySelector('[role="group"][aria-label="Other projects"]')).toBeNull()

    const newProject = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (element) => element.textContent?.includes('New project')
    )
    await act(async () => newProject?.click())
    expect(useNavigationStore.getState()).toMatchObject({
      view: 'home',
      pendingProjectCreation: true
    })
  })

  it('excludes individually archived sessions from artifact queries', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-a' ? { ...session, archivedAt: 3 } : session
      )
    }))
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(window.api.projectFiles.searchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ excludedSessionIds: ['session-a'] })
    )
  })

  it('says what was searched when a finished content search finds nothing', async () => {
    vi.mocked(window.api.search.query).mockResolvedValue({
      schemaVersion: 1,
      query: 'nohit',
      scopes: ['sessions', 'messages', 'files', 'literature'],
      hits: [],
      counts: { sessions: 0, messages: 0, files: 0, literature: 0 },
      truncated: false,
      scan: { sessions: 74, messages: 1951, files: 0, references: 0, bounded: false },
      appliedLimit: 100,
      notes: []
    })

    await act(async () => {
      // The real provider, not the English fallback: the fallback does not interpolate, so a test that
      // skips the provider cannot see whether the placeholders in the line are actually filled in.
      root.render(
        <LanguageProvider>
          <GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />
        </LanguageProvider>
      )
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'nohit')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    })

    const empty = document.body.querySelector('[data-testid="global-search-content-empty"]')
    expect(empty).toBeTruthy()
    // The line reports the real scope, so an empty result cannot read as "nothing was searched".
    expect(empty?.textContent).toContain('74')
    expect(empty?.textContent).toContain('1951')
    expect(document.body.textContent).not.toContain('Content search failed')
  })

  it('renders content hits with their provenance and opens the matched session', async () => {
    const openSession = vi.spyOn(useNavigationStore.getState(), 'openSession')
    vi.mocked(window.api.search.query).mockResolvedValue({
      schemaVersion: 1,
      query: 'sin',
      scopes: ['sessions', 'messages', 'files', 'literature'],
      hits: [
        {
          scope: 'messages',
          id: 'message-2',
          projectId: 'project-a',
          title: 'Sine plot',
          score: 9,
          matches: [{ field: 'body', snippet: 'wrote sin(x) values', offset: 6 }],
          sessionId: 'session-a',
          role: 'agent',
          timestamp: '2026-09-13T00:00:00.000Z'
        },
        {
          scope: 'files',
          id: 'file-1',
          projectId: 'project-a',
          title: 'sin_probe.csv',
          score: 6,
          matches: [{ field: 'name', snippet: 'sin_probe.csv', offset: 0 }],
          relativePath: 'data/sin_probe.csv'
        }
      ],
      counts: { sessions: 0, messages: 1, files: 1, literature: 0 },
      truncated: false,
      scan: { sessions: 1, messages: 2, files: 1, references: 0, bounded: false },
      appliedLimit: 100,
      notes: []
    })
    const onOpenChange = vi.fn()

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      // Past the debounce, so the content query has actually been issued.
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    })

    expect(window.api.search.query).toHaveBeenCalledWith(expect.objectContaining({ query: 'sin' }))

    const contentSection = [...document.body.querySelectorAll('[role="group"]')].find(
      (section) => section.querySelector('[data-testid="global-search-content-row"]') !== null
    )
    const rows = [...document.body.querySelectorAll('[data-testid="global-search-content-row"]')]
    expect(contentSection).toBeTruthy()
    expect(rows).toHaveLength(2)
    // Provenance, not just a snippet: scope, project/session and the message's role.
    expect(rows[0].textContent).toContain('Message')
    expect(rows[0].textContent).toContain('agent')
    expect(rows[0].textContent).toContain('wrote sin(x) values')
    expect(rows[1].textContent).toContain('File')

    await act(async () => {
      rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(openSession).toHaveBeenCalledWith('project-a', 'session-a', 'user')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    // The workspace is handed the exact message, not just the session.
    expect(useNavigationStore.getState().pendingMessageFocus).toEqual({
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2'
    })
  })

  it('copies a GB/T 7714 citation for a literature hit that carries citation data', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.mocked(window.api.search.query).mockResolvedValue({
      schemaVersion: 1,
      query: 'sin',
      scopes: ['sessions', 'messages', 'files', 'literature'],
      hits: [
        {
          scope: 'literature',
          id: 'reference-1',
          projectId: 'project-a',
          title: 'Reproducible sine tables',
          score: 9,
          matches: [{ field: 'title', snippet: 'sine', offset: 14 }],
          projectName: 'Nature Methods',
          citation: {
            authors: ['Zhang San', 'Li Si'],
            year: 2024,
            venue: 'Nature Methods',
            doi: '10.1000/xyz'
          }
        }
      ],
      counts: { sessions: 0, messages: 0, files: 0, literature: 1 },
      truncated: false,
      scan: { sessions: 0, messages: 0, files: 0, references: 1, bounded: false },
      appliedLimit: 100,
      notes: []
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    })

    const button = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="global-search-copy-citation"]'
    )
    expect(button).toBeTruthy()

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    // The citation comes from the record the search returned, in GB/T 7714 form.
    expect(writeText).toHaveBeenCalledTimes(1)
    const citation = writeText.mock.calls[0][0] as string
    expect(citation).toContain('San Z., Si L.')
    expect(citation).toContain('Reproducible sine tables')
    expect(citation).toContain('Nature Methods')
    expect(citation).toContain('2024')
  })

  it('shows no citation action for a literature hit that carries none', async () => {
    vi.mocked(window.api.search.query).mockResolvedValue({
      schemaVersion: 1,
      query: 'sin',
      scopes: ['sessions', 'messages', 'files', 'literature'],
      hits: [
        {
          scope: 'literature',
          id: 'reference-2',
          projectId: 'project-a',
          title: 'Untitled draft',
          score: 5,
          matches: [{ field: 'title', snippet: 'Untitled', offset: 0 }]
        }
      ],
      counts: { sessions: 0, messages: 0, files: 0, literature: 1 },
      truncated: false,
      scan: { sessions: 0, messages: 0, files: 0, references: 1, bounded: false },
      appliedLimit: 100,
      notes: []
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    })

    expect(document.body.querySelector('[data-testid="global-search-content-row"]')).toBeTruthy()
    // No citation data means no button — rather than a button that copies an empty reference.
    expect(document.body.querySelector('[data-testid="global-search-copy-citation"]')).toBeNull()
  })

  it('copies a fingerprintable evidence line for a message hit and rechecks it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const evidenceCalls: unknown[] = []
    const line = {
      schemaVersion: 1 as const,
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      role: 'agent' as const,
      capturedAt: '2026-09-14T10:00:00.000Z',
      query: 'sin csv',
      terms: ['sin', 'csv'],
      snippet: 'wrote sin(x) values',
      fingerprint: `sha256:${'b'.repeat(64)}`
    }
    const evidence = vi.fn().mockImplementation(async (request: { action: string }) => {
      evidenceCalls.push(request)
      return request.action === 'capture'
        ? { status: 'captured', line }
        : { status: 'verified', fingerprint: line.fingerprint }
    })
    Object.defineProperty(window.api.search, 'evidence', { configurable: true, value: evidence })
    vi.mocked(window.api.search.query).mockResolvedValue({
      schemaVersion: 1,
      query: 'sin csv',
      scopes: ['sessions', 'messages', 'files', 'literature'],
      hits: [
        {
          scope: 'messages',
          id: 'message-2',
          projectId: 'project-a',
          title: 'Sine plot',
          score: 9,
          matches: [{ field: 'body', snippet: 'wrote sin(x) values', offset: 6 }],
          sessionId: 'session-a',
          role: 'agent'
        }
      ],
      counts: { sessions: 0, messages: 1, files: 0, literature: 0 },
      truncated: false,
      scan: { sessions: 1, messages: 1, files: 0, references: 0, bounded: false },
      appliedLimit: 100,
      notes: []
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin csv')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    })

    const capture = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="global-search-capture-evidence"]'
    )
    expect(capture).toBeTruthy()

    await act(async () => {
      capture?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    // The capture asks main for the line; the query travels with it as the terms that found the block.
    expect(evidenceCalls[0]).toEqual({
      action: 'capture',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      query: 'sin csv',
      terms: ['sin', 'csv'],
      snippet: 'wrote sin(x) values'
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toContain('Evidence: project-a / session-a / message-2 (agent)')
    expect(copied).toContain('Query: sin csv')
    expect(copied).toContain(`Fingerprint: sha256:${'b'.repeat(64)}`)

    const verify = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="global-search-verify-evidence"]'
    )
    expect(verify).toBeTruthy()

    await act(async () => {
      verify?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(evidenceCalls[1]).toEqual({ action: 'verify', line })
    expect(
      document.body.querySelector('[data-testid="global-search-evidence-status"]')?.textContent
    ).toBe('Evidence verified')
  })

  it('says the evidence changed instead of implying it still holds', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    })
    const line = {
      schemaVersion: 1 as const,
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      role: 'agent' as const,
      capturedAt: '2026-09-14T10:00:00.000Z',
      query: 'sin',
      terms: ['sin'],
      snippet: 'wrote sin(x) values',
      fingerprint: `sha256:${'b'.repeat(64)}`
    }
    const evidence = vi.fn().mockImplementation(async (request: { action: string }) =>
      request.action === 'capture'
        ? { status: 'captured', line }
        : {
            status: 'unavailable',
            reason: 'fingerprint-mismatch',
            fingerprintNow: `sha256:${'c'.repeat(64)}`
          }
    )
    Object.defineProperty(window.api.search, 'evidence', { configurable: true, value: evidence })
    vi.mocked(window.api.search.query).mockResolvedValue({
      schemaVersion: 1,
      query: 'sin',
      scopes: ['messages'],
      hits: [
        {
          scope: 'messages',
          id: 'message-2',
          projectId: 'project-a',
          title: 'Sine plot',
          score: 9,
          matches: [{ field: 'body', snippet: 'wrote sin(x) values', offset: 6 }],
          sessionId: 'session-a',
          role: 'agent'
        }
      ],
      counts: { sessions: 0, messages: 1, files: 0, literature: 0 },
      truncated: false,
      scan: { sessions: 1, messages: 1, files: 0, references: 0, bounded: false },
      appliedLimit: 100,
      notes: []
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    })

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="global-search-capture-evidence"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="global-search-verify-evidence"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(
      document.body.querySelector('[data-testid="global-search-evidence-status"]')?.textContent
    ).toBe('Evidence changed')
  })

  it('says files are matched by name and path when the response carries that note', async () => {
    vi.mocked(window.api.search.query).mockResolvedValue({
      schemaVersion: 1,
      query: 'sin',
      scopes: ['files'],
      hits: [],
      counts: { sessions: 0, messages: 0, files: 0, literature: 0 },
      truncated: false,
      scan: { sessions: 0, messages: 0, files: 3, references: 0, bounded: false },
      appliedLimit: 100,
      notes: ['files-matched-by-name-and-path']
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    })

    // The palette repeats the response's own limit instead of letting an empty file list read as
    // "that text is not in any file".
    expect(
      document.body.querySelector('[data-testid="global-search-files-name-only"]')?.textContent
    ).toBe('Files are matched by name and path only - file text is not searched')
  })

  it('pins a captured line to the session\u2019s only review and says so', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    })
    const line = {
      schemaVersion: 1 as const,
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      role: 'agent' as const,
      capturedAt: '2026-09-14T10:00:00.000Z',
      query: 'sin',
      terms: ['sin'],
      snippet: 'wrote sin(x) values',
      fingerprint: `sha256:${'b'.repeat(64)}`
    }
    const attach = vi.fn(async () => ({ status: 'attached', evidence: { id: 'pin-1' } }))
    Object.defineProperty(window.api.search, 'evidence', {
      configurable: true,
      value: vi.fn(async (request: { action: string }) =>
        request.action === 'capture' ? { status: 'captured', line } : { status: 'verified' }
      )
    })
    Object.defineProperty(window.api, 'reviewer', {
      configurable: true,
      value: {
        getForSession: vi.fn(async () => [
          { id: 'review-1', createdAt: 1710000000000, turnMessageId: 'turn-1' }
        ]),
        evidence: attach
      }
    })
    vi.mocked(window.api.search.query).mockResolvedValue({
      schemaVersion: 1,
      query: 'sin',
      scopes: ['messages'],
      hits: [
        {
          scope: 'messages',
          id: 'message-2',
          projectId: 'project-a',
          title: 'Sine plot',
          score: 9,
          matches: [{ field: 'body', snippet: 'wrote sin(x) values', offset: 6 }],
          sessionId: 'session-a',
          role: 'agent'
        }
      ],
      counts: { sessions: 0, messages: 1, files: 0, literature: 0 },
      truncated: false,
      scan: { sessions: 1, messages: 1, files: 0, references: 0, bounded: false },
      appliedLimit: 100,
      notes: []
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="global-search-capture-evidence"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="global-search-pin-review"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    // Reviews are read from the block's own session, then the line is filed into the only review.
    expect(window.api.reviewer.getForSession).toHaveBeenCalledWith({
      projectId: 'project-a',
      appSessionId: 'session-a'
    })
    expect(attach).toHaveBeenCalledWith({ action: 'attach', reviewId: 'review-1', line })
    expect(
      document.body.querySelector('[data-testid="global-search-pin-status"]')?.textContent
    ).toBe('Pinned to the review')
  })

  it('offers the session\u2019s reviews when there is more than one to choose from', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    })
    const line = {
      schemaVersion: 1 as const,
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      role: 'agent' as const,
      capturedAt: '2026-09-14T10:00:00.000Z',
      query: 'sin',
      terms: ['sin'],
      snippet: 'wrote sin(x) values',
      fingerprint: `sha256:${'b'.repeat(64)}`
    }
    const attach = vi.fn(async () => ({ status: 'attached', evidence: { id: 'pin-1' } }))
    Object.defineProperty(window.api.search, 'evidence', {
      configurable: true,
      value: vi.fn(async (request: { action: string }) =>
        request.action === 'capture' ? { status: 'captured', line } : { status: 'verified' }
      )
    })
    Object.defineProperty(window.api, 'reviewer', {
      configurable: true,
      value: {
        getForSession: vi.fn(async () => [
          { id: 'review-1', createdAt: 1710000000000, turnMessageId: 'turn-1' },
          { id: 'review-2', createdAt: 1710003600000, turnMessageId: 'turn-2' }
        ]),
        evidence: attach
      }
    })
    vi.mocked(window.api.search.query).mockResolvedValue({
      schemaVersion: 1,
      query: 'sin',
      scopes: ['messages'],
      hits: [
        {
          scope: 'messages',
          id: 'message-2',
          projectId: 'project-a',
          title: 'Sine plot',
          score: 9,
          matches: [{ field: 'body', snippet: 'wrote sin(x) values', offset: 6 }],
          sessionId: 'session-a',
          role: 'agent'
        }
      ],
      counts: { sessions: 0, messages: 1, files: 0, literature: 0 },
      truncated: false,
      scan: { sessions: 1, messages: 1, files: 0, references: 0, bounded: false },
      appliedLimit: 100,
      notes: []
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="global-search-capture-evidence"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="global-search-pin-review"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    // Nothing is filed until a review is chosen.
    expect(attach).not.toHaveBeenCalled()
    const choices = document.body.querySelectorAll('[data-testid="global-search-pin-choice"]')
    expect(choices).toHaveLength(2)

    await act(async () => {
      choices[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(attach).toHaveBeenCalledWith({ action: 'attach', reviewId: 'review-2', line })
  })
})
