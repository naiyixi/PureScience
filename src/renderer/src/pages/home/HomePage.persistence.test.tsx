// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project, ProjectDeletionOutcome } from '../../../../shared/projects'
import { formatBytes } from '../../../../shared/update'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { HomePage } from './HomePage'

vi.mock('@/components/GitHubStarBadge', () => ({ GitHubStarBadge: () => null }))
vi.mock('@/components/NetworkStatusIndicator', () => ({ NetworkStatusIndicator: () => null }))
vi.mock('@/components/ThemeControls', () => ({ ThemePreferenceMenu: () => null }))
vi.mock('@/components/UpdateCapsule', () => ({ UpdateCapsule: () => null }))
vi.mock('./ProjectFormDialog', () => ({ ProjectFormDialog: () => null }))
vi.mock('./DeleteProjectDialog', () => ({
  DeleteProjectDialog: ({
    project,
    canDelete,
    hasCompleteSessionCatalog,
    isDeleting,
    error,
    onConfirmDelete
  }: {
    project: Project | undefined
    canDelete: boolean
    hasCompleteSessionCatalog: boolean
    isDeleting: boolean
    error: string | undefined
    onConfirmDelete: () => void
  }) => (
    <>
      <button
        type="button"
        data-testid="confirm-project-delete"
        data-can-delete={String(canDelete)}
        data-has-project={String(Boolean(project))}
        data-has-complete-session-catalog={String(hasCompleteSessionCatalog)}
        data-is-deleting={String(isDeleting)}
        disabled={isDeleting}
        onClick={onConfirmDelete}
      >
        Confirm delete
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </>
  )
}))
vi.mock('radix-ui', () => ({
  DropdownMenu: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => <>{children}</>,
    Separator: () => null,
    Item: ({
      children,
      disabled,
      onSelect
    }: {
      children: ReactNode
      disabled?: boolean
      onSelect?: () => void
    }) => (
      <button type="button" disabled={disabled} onClick={onSelect}>
        {children}
      </button>
    )
  }
}))

const project: Project = {
  id: 'project-1',
  name: 'Protected project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

// The deletion reports what it measured on its way out, so every stub has to answer with a real outcome:
// the surface reads those figures, and an `undefined` stub would exercise a shape the app never produces.
const deletionOutcome = (
  overrides: Partial<ProjectDeletionOutcome> = {}
): ProjectDeletionOutcome => ({
  freedBytes: 0,
  runDataBytes: 0,
  artifactBytes: 0,
  uploadBytes: 0,
  runData: 'absent',
  ...overrides
})

describe('HomePage persistence recovery', () => {
  let container: HTMLDivElement
  let root: Root
  let deleteProject: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    deleteProject = vi.fn().mockResolvedValue(deletionOutcome())
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true,
      deleteProject
    } as never)
    useSessionStore.setState(createInitialSessionState())
    useNavigationStore.setState({
      view: 'home',
      activeProjectId: undefined,
      userNavigationRevision: 0,
      explicitNavigationRevision: 0
    })
    useSettingsStore.setState(createInitialSettingsState())
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('disables project deletion while session persistence is recovering', async () => {
    await act(async () =>
      root.render(<HomePage canDeleteProjects={false} hasCompleteSessionCatalog={false} />)
    )

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )

    expect(deleteAction?.disabled).toBe(true)
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.dataset
        .canDelete
    ).toBe('false')
  })

  it('does not present partial project Session counts as authoritative', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      projectId: project.id,
      cwd: '/workspace/project-1',
      content: 'Recovered conversation'
    })

    await act(async () =>
      root.render(<HomePage canDeleteProjects hasCompleteSessionCatalog={false} />)
    )

    expect(container.textContent).toContain('Session count unavailable')
    expect(container.textContent).not.toContain('1 session')
  })

  it('guards confirmation when persistence becomes unavailable after the dialog opens', async () => {
    await act(async () => root.render(<HomePage canDeleteProjects hasCompleteSessionCatalog />))

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )
    await act(async () => deleteAction?.click())

    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-project-delete"]'
    )
    expect(confirm?.dataset.hasProject).toBe('true')

    await act(async () =>
      root.render(<HomePage canDeleteProjects={false} hasCompleteSessionCatalog={false} />)
    )
    expect(confirm?.dataset.canDelete).toBe('false')
    await act(async () => confirm?.click())

    expect(deleteProject).not.toHaveBeenCalled()
  })

  it('records explicit user takeover before starting Project deletion', async () => {
    await act(async () =>
      root.render(<HomePage canDeleteProjects hasCompleteSessionCatalog={false} />)
    )

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )
    await act(async () => deleteAction?.click())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.click()
    )

    expect(useNavigationStore.getState().userNavigationRevision).toBe(1)
    expect(deleteProject).toHaveBeenCalledWith(project.id)
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.dataset
        .hasCompleteSessionCatalog
    ).toBe('false')
  })

  it('keeps the confirmation open, explains a durable deletion failure, and allows retry', async () => {
    deleteProject.mockRejectedValueOnce(new Error('Project storage is unavailable.'))

    await act(async () => root.render(<HomePage canDeleteProjects hasCompleteSessionCatalog />))

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )
    await act(async () => deleteAction?.click())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.click()
    )

    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-project-delete"]'
    )
    expect(confirm?.dataset.hasProject).toBe('true')
    expect(confirm?.dataset.isDeleting).toBe('false')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Project storage is unavailable.'
    )
    expect(useProjectStore.getState().projects).toContainEqual(project)

    deleteProject.mockResolvedValueOnce(deletionOutcome())
    await act(async () => confirm?.click())

    expect(deleteProject).toHaveBeenCalledTimes(2)
    expect(confirm?.dataset.hasProject).toBe('false')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  // The deletion is irreversible, so the result the user is left holding has to be the deletion's own
  // measurement rather than a generic "done". These three cases are the three states the outcome can be in.
  const runDelete = async (outcome: ProjectDeletionOutcome): Promise<void> => {
    deleteProject.mockResolvedValueOnce(outcome)
    await act(async () => root.render(<HomePage canDeleteProjects hasCompleteSessionCatalog />))

    const deleteAction = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Delete'
    )
    await act(async () => deleteAction?.click())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="confirm-project-delete"]')?.click()
    )
  }

  it('reports the bytes the deletion freed and lets the user dismiss the receipt', async () => {
    await runDelete(deletionOutcome({ freedBytes: 7168, runDataBytes: 4096, artifactBytes: 3072 }))

    const receipt = container.querySelector('[data-slot="home-project-deleted"]')
    expect(receipt?.getAttribute('role')).toBe('status')
    expect(receipt?.textContent).toContain(project.name)
    expect(receipt?.textContent).toContain(formatBytes(7168, 'en'))

    const dismiss = receipt?.querySelector<HTMLButtonElement>('button')
    await act(async () => dismiss?.click())
    expect(container.querySelector('[data-slot="home-project-deleted"]')).toBeNull()
  })

  it('says nothing was stored instead of reporting a release of zero bytes', async () => {
    await runDelete(deletionOutcome())

    const receipt = container.querySelector('[data-slot="home-project-deleted"]')
    expect(receipt?.textContent).toBe(
      `${project.name} was deleted. No stored data was found for it.`
    )
  })

  it('states the deletion without a byte claim when nothing was measured', async () => {
    await runDelete(deletionOutcome({ runData: 'not-attempted' }))

    const receipt = container.querySelector('[data-slot="home-project-deleted"]')
    // 'not-attempted' means nothing was measured here — never "there was none". Reporting a zero-byte
    // release, or worse "no stored data was found", would be a claim this call cannot support.
    expect(receipt?.textContent).toBe(`${project.name} was deleted.`)
  })

  it('says the run data was released without inventing a size when none could be read', async () => {
    await runDelete(
      deletionOutcome({ runData: 'removed', runDataBytes: 0, runDataBytesState: 'unreadable' })
    )

    const receipt = container.querySelector('[data-slot="home-project-deleted"]')
    // This outcome's zero means "nobody measured it", so the receipt must not fall through to "no stored
    // data was found": the run data was there and the deletion removed it.
    expect(receipt?.textContent).toBe(
      `${project.name} was deleted. Its run data was released, but its size could not be read.`
    )
  })

  it('keeps a refused run-data cleanup visible above the release figure', async () => {
    await runDelete(deletionOutcome({ freedBytes: 3072, runData: 'refused' }))

    const receipt = container.querySelector('[data-slot="home-project-deleted"]')
    // The refusal matters more than the partial total: the user is told some bytes survived, so the
    // receipt must not read as a clean success.
    expect(receipt?.textContent).toBe(
      `${project.name} was deleted, but some of its run data could not be removed.`
    )
    expect(receipt?.textContent).not.toContain(formatBytes(3072, 'en'))
  })
})
