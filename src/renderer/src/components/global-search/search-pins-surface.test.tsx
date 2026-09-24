// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LanguageProvider } from '@/i18n'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { GLOBAL_SEARCH_PIN_SCHEMA_VERSION } from '../../../../shared/global-search-pins'

import { GlobalSearchDialog } from './GlobalSearchDialog'

// The saved-filter-set surface, driven the way a user drives it: name a set, save it, apply it, and watch
// what the search is actually asked for. The applied set is what an evidence line carries, so what matters
// is that applying changes the request — not that a button lit up.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

let container: HTMLDivElement
let root: Root
let searchQuery: ReturnType<typeof vi.fn>
let searchEvidence: ReturnType<typeof vi.fn>
let pinList: ReturnType<typeof vi.fn>
let pinSave: ReturnType<typeof vi.fn>
let pinRemove: ReturnType<typeof vi.fn>

const evidenceLine = {
  schemaVersion: 1,
  projectId: 'project-a',
  sessionId: 'session-a',
  messageId: 'message-1',
  role: 'agent',
  capturedAt: '2026-09-21T10:00:00.000Z',
  query: 'sin',
  terms: ['sin'],
  snippet: '…sin…',
  fingerprint: `sha256:${'a'.repeat(64)}`
}

const emptyResult = (query: string): unknown => ({
  schemaVersion: 1,
  query,
  scopes: ['sessions', 'messages', 'files', 'literature'],
  hits: [],
  counts: { sessions: 0, messages: 0, files: 0, literature: 0 },
  truncated: false,
  scan: { sessions: 0, messages: 0, files: 0, references: 0, bounded: false },
  appliedLimit: 100,
  notes: []
})

// The filter bar and the pins row appear once there is a search to filter, so every case here starts by
// asking for one — the same way the filter bar's own tests do.
const enterSearchMode = async (value = 'sin'): Promise<void> => {
  const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
  if (!input) throw new Error('the palette input is not there')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise((resolve) => window.setTimeout(resolve, 500))
  })
}

const setInputValue = async (element: HTMLInputElement | null, value: string): Promise<void> => {
  if (!element) throw new Error('no input to type into')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
}

const chooseFilter = async (label: string, optionText: string): Promise<void> => {
  const trigger = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (!trigger) throw new Error(`no filter control for ${label}`)
  await act(async () => {
    trigger.dispatchEvent(
      new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    )
    trigger.click()
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  })
  const option = [
    ...document.body.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"]')
  ].find((node) => node.textContent?.trim() === optionText)
  if (!option) throw new Error(`no option named ${optionText}`)
  await act(async () => {
    option.click()
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  })
}

const pinNameInput = (): HTMLInputElement | null =>
  document.body.querySelector<HTMLInputElement>('[data-testid="global-search-pin-name"]')

const pinsCountText = (): string =>
  document.body.querySelector('[data-testid="global-search-pins-count"]')?.textContent ?? ''

const pinStatusText = (): string =>
  document.body.querySelector('[data-testid="global-search-pin-status"]')?.textContent ?? ''

const clickTestId = async (testId: string): Promise<void> => {
  const element = document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (!element) throw new Error(`no element for ${testId}`)
  await act(async () => {
    element.click()
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
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
        title: 'Alpha session',
        cwd: '/workspace',
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        artifacts: []
      }
    ]
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

  searchQuery = vi.fn(async (request: { query: string }) => emptyResult(request.query))
  searchEvidence = vi.fn(async () => ({ status: 'captured', line: evidenceLine }))
  pinList = vi.fn(async () => [])
  pinRemove = vi.fn(async () => true)
  pinSave = vi.fn(async (input: { name: string }) => ({
    schemaVersion: GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
    id: 'pin-1',
    name: input.name,
    savedAt: '2026-09-21T10:00:00.000Z',
    filters: { role: 'agent', extensions: ['csv'] }
  }))

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      projectFiles: {
        searchArtifacts: vi.fn().mockResolvedValue({
          primary: { items: [], totalCount: 0 },
          other: [],
          isIndexComplete: true
        })
      },
      search: { query: searchQuery, evidence: searchEvidence },
      searchPins: { list: pinList, save: pinSave, remove: pinRemove },
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

const renderDialog = async (): Promise<void> => {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <GlobalSearchDialog
          open
          onOpenChange={vi.fn()}
          isSessionPersistenceReady
          onOpenKeyboardShortcuts={vi.fn()}
        />
      </LanguageProvider>
    )
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
}

describe('the saved-filter-set surface', () => {
  it('shows how many sets are saved against the limit, and says so when there are none', async () => {
    await renderDialog()
    await enterSearchMode()

    expect(document.body.querySelector('[data-testid="global-search-pins"]')).not.toBeNull()
    expect(pinsCountText()).toContain('0')
    expect(pinsCountText()).toContain('50')
  })

  it('saves the filters in force under the name the user typed', async () => {
    await renderDialog()
    await enterSearchMode()
    await chooseFilter('Sender', 'Agent')

    await setInputValue(pinNameInput(), 'Agent notes')
    await clickTestId('global-search-pin-save')

    // The set handed to the repository is the one the palette can actually reproduce.
    expect(pinSave).toHaveBeenCalledWith({ name: 'Agent notes', filters: { role: 'agent' } })
    expect(pinsCountText()).toContain('1')
    expect(pinStatusText()).toContain('Saved')
    // ...and the box is cleared, so the same set is not saved twice under one name.
    expect(pinNameInput()?.value).toBe('')
  })

  it('refuses to save with no filter set, and says why', async () => {
    await renderDialog()
    await enterSearchMode()

    await setInputValue(pinNameInput(), 'Everything')
    await clickTestId('global-search-pin-save')

    expect(pinSave).not.toHaveBeenCalled()
    expect(pinStatusText()).toContain('at least one filter')
  })

  it('says a duplicate name is a duplicate rather than a generic failure', async () => {
    pinSave.mockRejectedValueOnce(new Error('a saved filter set already uses that name'))
    await renderDialog()
    await enterSearchMode()
    await chooseFilter('Sender', 'Agent')

    await setInputValue(pinNameInput(), 'Agent notes')
    await clickTestId('global-search-pin-save')

    expect(pinStatusText()).toContain('already uses that name')
    expect(pinsCountText()).toContain('0')
  })

  it('applies a saved set back onto the search that is actually sent', async () => {
    pinList.mockResolvedValue([
      {
        schemaVersion: GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
        id: 'pin-1',
        name: 'Agent only',
        savedAt: '2026-09-21T10:00:00.000Z',
        filters: { role: 'agent' }
      }
    ])
    await renderDialog()
    await enterSearchMode()
    await clickTestId('global-search-pin-apply-pin-1')
    // The query is debounced, so the request that carries the applied filter is not the one already in
    // flight when the set is clicked.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 500))
    })

    // The content-search call lands after the session query and carries its filters nested, so the
    // assertion is about the request that the pin's role actually reached.
    const roleRequests = searchQuery.mock.calls.filter(
      ([request]) => (request as { role?: string }).role === 'agent'
    )
    expect(roleRequests.length).toBeGreaterThan(0)
    // Being applied is derived from the filters, so the set is marked as soon as they agree.
    expect(
      document.body.querySelector('[data-testid="global-search-pin-applied-pin-1"]')
    ).not.toBeNull()
  })
})

describe('the applied set on a copied evidence line', () => {
  it('names the set and the filters it stood for', async () => {
    pinList.mockResolvedValue([
      {
        schemaVersion: GLOBAL_SEARCH_PIN_SCHEMA_VERSION,
        id: 'pin-1',
        name: 'Agent only',
        savedAt: '2026-09-21T10:00:00.000Z',
        filters: { role: 'agent' }
      }
    ])
    searchQuery.mockResolvedValue({
      ...(emptyResult('sin') as Record<string, unknown>),
      hits: [
        {
          scope: 'messages',
          id: 'message-1',
          projectId: 'project-a',
          title: 'Sine plot',
          score: 9,
          matches: [{ field: 'body', snippet: 'wrote sin(x)', offset: 0 }],
          sessionId: 'session-a',
          role: 'agent'
        }
      ],
      counts: { sessions: 0, messages: 1, files: 0, literature: 0 }
    })
    await renderDialog()
    await enterSearchMode()
    await clickTestId('global-search-pin-apply-pin-1')
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 500))
    })

    await clickTestId('global-search-capture-evidence')

    // The line says which saved set produced the result, and what that set accepts — the name alone could
    // not be checked by whoever reads the line later, because the set can be edited after the capture.
    expect(searchEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'capture',
        messageId: 'message-1',
        pinnedFilters: { name: 'Agent only', description: 'role=agent' }
      })
    )
  })

  it('carries no attribution when the filters in force are not a saved set', async () => {
    searchQuery.mockResolvedValue({
      ...(emptyResult('sin') as Record<string, unknown>),
      hits: [
        {
          scope: 'messages',
          id: 'message-1',
          projectId: 'project-a',
          title: 'Sine plot',
          score: 9,
          matches: [{ field: 'body', snippet: 'wrote sin(x)', offset: 0 }],
          sessionId: 'session-a',
          role: 'agent'
        }
      ],
      counts: { sessions: 0, messages: 1, files: 0, literature: 0 }
    })
    await renderDialog()
    await enterSearchMode()
    await clickTestId('global-search-capture-evidence')

    const request = searchEvidence.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(request.pinnedFilters).toBeUndefined()
  })
})
