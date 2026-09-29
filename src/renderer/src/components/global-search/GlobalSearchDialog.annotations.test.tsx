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

import { GlobalSearchDialog } from './GlobalSearchDialog'
import type { GlobalSearchResponse } from '../../../../shared/global-search'

// The annotation scope in the palette (文档标注层 A5, 需求 1), rendered.
//
// What the surface owes the reader is that an annotation hit is legible as one: it says the hit is a
// markup, which file VERSION it is anchored to, and which page — because a search reads the annotation
// store and never resolves the file, so it reports the version the markup is on rather than implying it is
// still the bytes on disk. And when the project has no markup to search, it says that, so a miss cannot be
// read as "the phrase is not in your annotations".

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

let container: HTMLDivElement
let root: Root

const response = (overrides: Partial<GlobalSearchResponse> = {}): GlobalSearchResponse => ({
  schemaVersion: 1,
  query: 'effect',
  scopes: ['annotations'],
  hits: [],
  counts: { sessions: 0, messages: 0, files: 0, literature: 0, annotations: 0 },
  truncated: false,
  scan: { sessions: 0, messages: 0, files: 0, references: 0, annotations: 0, bounded: false },
  appliedLimit: 100,
  notes: [],
  ...overrides
})

const annotationHit: GlobalSearchResponse['hits'][number] = {
  scope: 'annotations',
  id: 'annotation-1',
  projectId: 'project-a',
  title: 'paper.pdf',
  score: 12,
  matches: [{ field: 'quote', snippet: '…the effect is large…', offset: 4 }],
  annotation: {
    annotationId: 'annotation-1',
    sourceFileId: 'artifact-1',
    versionId: 'version-7',
    checksum: 'a'.repeat(64),
    kind: 'highlight',
    page: 4,
    quote: 'the effect is large'
  }
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
    sessions: []
  })
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project-a',
    userNavigationRevision: 0,
    explicitNavigationRevision: 0,
    pendingCustomizePrefill: undefined,
    pendingProjectCreation: false,
    pendingArtifactMention: undefined,
    artifactMentionAvailability: { projectId: 'project-a', canMention: false }
  })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())

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
      search: {
        query: vi.fn().mockResolvedValue(response()),
        evidence: vi.fn()
      },
      previewResources: {
        acquire: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const search = async (query: string): Promise<void> => {
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

  const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set
  await act(async () => {
    valueSetter?.call(input, query)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => window.setTimeout(resolve, 400))
  })
}

describe('GlobalSearchDialog — the annotation scope', () => {
  it('shows an annotation hit as a markup, with the file version and the page it is anchored to', async () => {
    vi.mocked(window.api.search.query).mockResolvedValue(
      response({
        hits: [annotationHit],
        counts: { sessions: 0, messages: 0, files: 0, literature: 0, annotations: 1 },
        scan: { sessions: 0, messages: 0, files: 0, references: 0, annotations: 1, bounded: false }
      })
    )

    await search('effect')

    const rows = [...document.body.querySelectorAll('[data-testid="global-search-content-row"]')]
    expect(rows).toHaveLength(1)
    const text = rows[0]!.textContent ?? ''
    // The scope's own name, from the dictionary, so the row is identifiable as markup rather than a file.
    expect(text).toContain('Annotation')
    // …the version the markup is on, and the page. Both come from the hit, so a search never has to open a
    // file to say where the markup lives.
    expect(text).toContain('version-7')
    expect(text).toContain('page 4')
    expect(text).toContain('the effect is large')
    expect(text).toContain('paper.pdf')
  })

  it('says an empty annotation corpus is empty, rather than letting a miss speak for it', async () => {
    vi.mocked(window.api.search.query).mockResolvedValue(
      response({ hits: [], notes: ['annotations-empty'] })
    )

    await search('effect')

    const notice = document.body.querySelector('[data-testid="global-search-annotations-empty"]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent?.trim().length).toBeGreaterThan(0)
  })

  it('says when the annotation corpus stopped at its bound', async () => {
    vi.mocked(window.api.search.query).mockResolvedValue(
      response({ hits: [annotationHit], notes: ['annotations-bounded'] })
    )

    await search('effect')

    expect(
      document.body.querySelector('[data-testid="global-search-annotations-bounded"]')
    ).not.toBeNull()
  })
})
