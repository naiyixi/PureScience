// @vitest-environment jsdom
// The user-case section on the real component and the real stores: what earns a card, what a card is
// allowed to be called, what the search actually searches, and what the detail panel hands over. The
// Files catalogue is the only thing mocked, and it is mocked as data the app already returns.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'

import { clearCaseEvidenceCache } from './user-case-evidence'
import { UserCases } from './UserCases'

type ProjectFixture = {
  id: string
  name: string
  description?: string
  isExample?: boolean
  archivedAt?: number
  createdAt?: number
  updatedAt?: number
}

type SessionFixture = {
  id: string
  projectId: string
  title: string
  status: string
  messages: unknown[]
  createdAt?: number
  updatedAt?: number
}

type Catalogue = Record<string, { artifacts: { name: string; size: number }[]; uploads?: number }>

let container: HTMLDivElement
let root: Root

const installCatalogue = (catalogue: Catalogue): void => {
  vi.stubGlobal('api', {
    projectFiles: {
      getOverview: async ({ projectId }: { projectId: string }) => {
        const entry = catalogue[projectId]
        const artifacts = entry?.artifacts ?? []
        return {
          totalCount: artifacts.length + (entry?.uploads ?? 0),
          uploadCount: entry?.uploads ?? 0,
          artifactCount: artifacts.length,
          artifactGroupCount: artifacts.length > 0 ? 1 : 0,
          isIndexComplete: true
        }
      },
      listFiles: async ({ projectId }: { projectId: string }) => {
        const entry = catalogue[projectId]
        const items = (entry?.artifacts ?? []).map((artifact, index) => ({
          id: `${projectId}-${index}`,
          source: 'artifact' as const,
          sourceFileId: `${projectId}-file-${index}`,
          projectId,
          sessionId: `${projectId}-session`,
          name: artifact.name,
          path: artifact.name,
          size: artifact.size,
          sortAtMs: 0
        }))
        return { items, totalCount: items.length }
      }
    }
  })
}

const render = async (
  projects: ProjectFixture[],
  sessions: SessionFixture[],
  catalogue: Catalogue
): Promise<void> => {
  installCatalogue(catalogue)
  useProjectStore.setState({
    ...createInitialProjectState(),
    projects: projects as never,
    isLoaded: true
  } as never)
  useSessionStore.setState({
    ...createInitialSessionState(),
    sessions: sessions as never
  } as never)
  useNavigationStore.setState({ view: 'home', activeProjectId: undefined })

  await act(async () => {
    root.render(<UserCases />)
  })
  // Two flushes: the first resolves the Files reads, the second renders the cards built from them.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const session = (projectId: string, id = `${projectId}-s1`): SessionFixture => ({
  id,
  projectId,
  title: 'a turn',
  status: 'completed',
  messages: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000
})

const richFiles = [
  { name: 'egfr_tki_comparison_report.md', size: 4096 },
  { name: 'clean_egfr_tki_activity.py', size: 2048 },
  { name: 'heatmap_cellbased.png', size: 1_048_576 },
  { name: 'chembl_aggregate.csv', size: 8192 },
  { name: 'bindingdb_clean.csv', size: 4096 },
  { name: 'bindingdb_offtarget_top.csv', size: 2048 }
]

beforeEach(() => {
  clearCaseEvidenceCache()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('UserCases', () => {
  it('says in words when nothing has run, instead of drawing an empty grid', async () => {
    await render([{ id: 'p-empty', name: 'No runs yet' }], [], {})
    const empty = container.querySelector('[data-slot="case-plaza-empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('No project has a session yet')
    expect(container.querySelectorAll('[data-slot="case-plaza-card"]')).toHaveLength(0)
  })

  it('gives a rich case its own name, its standing and its readings', async () => {
    await render(
      [
        {
          id: 'p1',
          name: '化合物结构与靶点选择性审计',
          description: 'EGFR TKI 的选择性审计与热图',
          updatedAt: 1_700_000_000_000
        }
      ],
      [session('p1')],
      { p1: { artifacts: richFiles } }
    )

    const cards = container.querySelectorAll('[data-slot="case-plaza-card"]')
    expect(cards).toHaveLength(1)
    const card = cards[0] as HTMLElement
    // The case is named for its work, not for the folder it was typed into.
    expect(card.textContent).toContain('EGFR TKI 的选择性审计与热图')
    expect(card.textContent).not.toContain('化合物结构与靶点选择性审计')
    expect(card.textContent).toContain('Reproducible')
    expect(card.getAttribute('data-standing')).toBe('reproducible')
    expect(card.textContent).toContain('6 artifacts')
    expect(card.textContent).toContain('6 files')
    // The home page's rule: a partially loaded catalogue never prints a session count as authoritative.
    expect(card.textContent).not.toContain('1 session')
  })

  it('keeps a project that ran but produced nothing, and says what it is', async () => {
    await render([{ id: 'p2', name: 'Chat only project' }], [session('p2')], { p2: { artifacts: [] } })
    const card = container.querySelector('[data-slot="case-plaza-card"]') as HTMLElement | null
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Conversation only')
    expect(card?.getAttribute('data-standing')).toBe('conversation-only')
    // The card still carries the home page's fallback reading when no timestamp exists.
    expect(card?.textContent).toMatch(/Ran here|last active/)
  })

  it('searches the file names a case would hand over', async () => {
    await render(
      [
        { id: 'p3', name: 'rich', description: 'Rich case' },
        { id: 'p4', name: 'thin', description: 'Thin case' }
      ],
      [session('p3'), session('p4')],
      { p3: { artifacts: richFiles }, p4: { artifacts: [] } }
    )
    expect(container.querySelectorAll('[data-slot="case-plaza-card"]')).toHaveLength(2)

    const search = container.querySelector('[data-slot="case-plaza-search"]') as HTMLInputElement
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      setValue?.call(search, 'heatmap_cellbased')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const cards = container.querySelectorAll('[data-slot="case-plaza-card"]')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.textContent).toContain('Rich case')
    expect(container.querySelector('[data-slot="case-plaza-none"]')).toBeNull()
  })

  it('opens the case detail with the files it hands over, and can open the project itself', async () => {
    await render([{ id: 'p5', name: 'rich two', description: 'Docking audit' }], [session('p5')], {
      p5: { artifacts: richFiles }
    })

    const card = container.querySelector('[data-slot="case-plaza-card"]') as HTMLElement
    await act(async () => {
      card.click()
    })

    const detail = document.querySelector('[data-slot="case-plaza-detail"]')
    expect(detail).not.toBeNull()
    expect(detail?.textContent).toContain('egfr_tki_comparison_report.md')
    expect(detail?.textContent).toContain('Files this case hands over')

    const open = document.querySelector('[data-slot="case-plaza-detail-open"]') as HTMLElement
    await act(async () => {
      open.click()
    })
    expect(useNavigationStore.getState().activeProjectId).toBe('p5')
  })

  it('leaves example and archived projects out: they are not this reader’s work', async () => {
    await render(
      [
        { id: 'example', name: 'Bundled sample', isExample: true },
        { id: 'archived', name: 'Old work', archivedAt: 1 }
      ],
      [session('example'), session('archived')],
      { example: { artifacts: richFiles }, archived: { artifacts: richFiles } }
    )
    expect(container.querySelectorAll('[data-slot="case-plaza-card"]')).toHaveLength(0)
    expect(container.querySelector('[data-slot="case-plaza-empty"]')).not.toBeNull()
  })
})
