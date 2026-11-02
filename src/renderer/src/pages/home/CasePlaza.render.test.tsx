// @vitest-environment jsdom
// The plaza's inclusion rules, on the real component and the real stores: what makes a project a case, what
// keeps one out, and what the card is allowed to say when the app does not hold a timestamp. These are the
// combinations the certification spec cannot stage (it drives the product's own paths, so it can only show
// one project that ran and one that did not); the rules themselves live here.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'

import { CasePlaza } from './CasePlaza'

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

let container: HTMLDivElement
let root: Root

const render = async (projects: ProjectFixture[], sessions: SessionFixture[]): Promise<void> => {
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

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<CasePlaza />))
}

const cards = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="case-plaza-card"]'))

const project = (overrides: Partial<ProjectFixture> & { id: string }): ProjectFixture => ({
  name: overrides.id,
  isExample: false,
  createdAt: 1,
  ...overrides
})

const session = (
  overrides: Partial<SessionFixture> & { id: string; projectId: string }
): SessionFixture => ({
  title: overrides.id,
  status: 'idle',
  messages: [],
  createdAt: 2,
  ...overrides
})

beforeEach(() => {
  useProjectStore.setState(createInitialProjectState())
  useSessionStore.setState(createInitialSessionState())
  useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('CasePlaza inclusion rules', () => {
  it('says so when nothing has run, instead of drawing an empty grid', async () => {
    await render([], [])

    expect(document.body.textContent).toContain('No project has a session yet')
    expect(cards()).toHaveLength(0)
  })

  it('counts a project only once it has a session', async () => {
    await render(
      [project({ id: 'ran' }), project({ id: 'declared-only' })],
      [session({ id: 's1', projectId: 'ran' })]
    )

    const names = cards().map((card) => card.textContent ?? '')
    expect(names.some((text) => text.includes('ran'))).toBe(true)
    expect(names.some((text) => text.includes('declared-only'))).toBe(false)
    expect(document.body.textContent).not.toContain('No project has a session yet')
  })

  it('leaves an archived project out even when it ran', async () => {
    await render(
      [project({ id: 'archived', archivedAt: 5 })],
      [session({ id: 's1', projectId: 'archived' })]
    )

    expect(cards()).toHaveLength(0)
  })

  it('leaves a sample project out even when it ran', async () => {
    await render(
      [project({ id: 'sample', isExample: true })],
      [session({ id: 's1', projectId: 'sample' })]
    )

    expect(cards()).toHaveLength(0)
  })

  it('does not invent a timestamp: a case with none says it ran here', async () => {
    // Neither the session nor the project carries a stamp. The card must not print a date, a zero, or
    // "now" — the app holds no reading, so it says the one true thing it does know.
    await render(
      [project({ id: 'undated', createdAt: undefined, updatedAt: undefined })],
      [session({ id: 's1', projectId: 'undated', createdAt: undefined, updatedAt: undefined })]
    )

    const [card] = cards()
    expect(card.textContent).toContain('Ran here')
    expect(card.textContent).not.toContain('last active')
  })

  it('opens the project when the card is pressed', async () => {
    await render([project({ id: 'opened' })], [session({ id: 's1', projectId: 'opened' })])

    const [card] = cards()
    await act(async () => card.click())

    expect(useNavigationStore.getState().view).toBe('workspace')
    expect(useNavigationStore.getState().activeProjectId).toBe('opened')
  })
})
