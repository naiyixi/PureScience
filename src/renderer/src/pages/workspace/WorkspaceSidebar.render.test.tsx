// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatSession } from '@/stores/session-store'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceSidebar } from './WorkspaceSidebar'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Radix DropdownMenu calls pointer-capture APIs that jsdom does not implement.
// Replace with a flat render so items are always visible in the DOM.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: (): React.JSX.Element => <hr />,
  DropdownMenuSub: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuSubTrigger: ({
    children,
    disabled,
    ...rest
  }: PropsWithChildren<{ disabled?: boolean }>): React.JSX.Element => (
    <button type="button" disabled={disabled} {...rest}>
      {children}
    </button>
  ),
  DropdownMenuSubContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: PropsWithChildren<{
    disabled?: boolean
    onSelect?: () => void
  }>): React.JSX.Element => (
    <button type="button" disabled={disabled} onClick={onSelect} {...rest}>
      {children}
    </button>
  )
}))

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ')
}))

const createSession = (overrides: Partial<ChatSession>): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'running',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createMessage = (): ChatSession['messages'][number] => ({
  id: 'message-1',
  role: 'user',
  content: 'Ready',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
})

const renderSidebar = async (sessions: ChatSession[]): Promise<string> => {
  const { WorkspaceSidebar } = await import('./WorkspaceSidebar')

  return renderToStaticMarkup(
    <WorkspaceSidebar
      projectName="Example project"
      sessions={sessions}
      activeSessionId={sessions[0]?.id}
      canCreateConversation
      canMutateConversations
      canDeleteConversations
      onGoHome={vi.fn()}
      onNewConversation={vi.fn()}
      isFilesOpen={false}
      onOpenFiles={vi.fn()}
      onOpenSession={vi.fn()}
      onRenameSession={vi.fn()}
      canDownloadArtifacts
      onDownloadArtifacts={vi.fn()}
      onViewNotebook={vi.fn()}
      onExportSession={vi.fn()}
      onTogglePin={vi.fn()}
      onDeleteSession={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  )
}

// Renders the sidebar into the DOM (jsdom) so interaction wiring can be exercised with real
// clicks. The flat dropdown-menu mock keeps every menu item visible in the tree.
const renderSidebarDom = (
  props: Omit<React.ComponentProps<typeof WorkspaceSidebar>, 'sessions'> & {
    sessions: ChatSession[]
  }
): HTMLDivElement => {
  const container = document.createElement('div')
  document.body.appendChild(container)

  act(() => {
    createRoot(container).render(<WorkspaceSidebar {...props} />)
  })
  return container
}

const findByText = (container: HTMLElement, text: string): HTMLButtonElement => {
  const candidates = Array.from(container.querySelectorAll('button'))
  const match = candidates.find((button) => button.textContent?.trim() === text)
  if (!match) throw new Error(`Button with text "${text}" not found.`)
  return match
}

const clickByText = (container: HTMLElement, text: string): void => {
  act(() => {
    findByText(container, text).click()
  })
}

const findAllByText = (container: HTMLElement, text: string): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll('button')).filter(
    (button) => button.textContent?.trim() === text
  )

// Session row buttons embed an sr-only status label before the title, so match by substring.
const findRowButton = (container: HTMLElement, title: string): HTMLButtonElement => {
  const match = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(title)
  )
  if (!match) throw new Error(`Row button containing "${title}" not found.`)
  return match
}

const clickRow = (container: HTMLElement, title: string): void => {
  act(() => {
    findRowButton(container, title).click()
  })
}

const clickButtonAt = (container: HTMLElement, text: string, index: number): void => {
  act(() => {
    findAllByText(container, text)[index]?.click()
  })
}

describe('WorkspaceSidebar accessible render', () => {
  it('keeps the sidebar card inset even on both sides', async () => {
    const html = await renderSidebar([createSession({ id: 'session-a' })])

    expect(html).toContain('m-2 flex min-h-0 flex-1 flex-col rounded-lg')
    expect(html).not.toContain('mr-0')
  })

  it('reserves header padding for the external panel toggle without spacer markup', async () => {
    const html = await renderSidebar([createSession({ id: 'session-a' })])

    expect(html).toContain('flex items-start pr-9')
    expect(html).not.toContain('workspace-sidebar-toggle-slot')
  })

  it('renders non-visual session status text for assistive technology', async () => {
    const html = await renderSidebar([
      createSession({ id: 'running-session', status: 'running' }),
      createSession({
        id: 'permission-session',
        title: 'Permission session',
        status: 'waiting-permission'
      })
    ])

    expect(html).toContain('Session status: Running')
    expect(html).toContain('Session status: Waiting for permission')
  })

  it('gives each session action trigger a session-specific accessible name', async () => {
    const html = await renderSidebar([
      createSession({ id: 'session-a', title: 'Notebook review' }),
      createSession({ id: 'session-b', title: 'Dataset cleanup' })
    ])

    expect(html).toContain('aria-label="Open actions for Notebook review"')
    expect(html).toContain('aria-label="Open actions for Dataset cleanup"')
  })

  it('wires session open and row menu actions to the matching session', () => {
    const sessions = [
      createSession({ id: 'session-a', title: 'Notebook review' }),
      createSession({ id: 'session-b', title: 'Dataset cleanup' })
    ]
    const onOpenSession = vi.fn()
    const onRenameSession = vi.fn()
    const onDownloadArtifacts = vi.fn()
    const onDeleteSession = vi.fn()
    const onExportSession = vi.fn()
    const onArchiveSession = vi.fn()
    const container = renderSidebarDom({
      projectName: 'Example project',
      sessions,
      activeSessionId: sessions[0].id,
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession,
      onRenameSession,
      canDownloadArtifacts: true,
      onDownloadArtifacts,
      onViewNotebook: vi.fn(),
      onExportSession,
      onTogglePin: vi.fn(),
      canArchiveSession: () => true,
      onArchiveSession,
      onDeleteSession,
      onOpenSettings: vi.fn()
    })

    clickRow(container, 'Notebook review')
    expect(onOpenSession).toHaveBeenCalledWith('session-a')

    clickButtonAt(container, 'Rename…', 1)
    expect(onRenameSession).toHaveBeenCalledWith(sessions[1])

    clickButtonAt(container, 'Download all artifacts', 1)
    expect(onDownloadArtifacts).toHaveBeenCalledWith(sessions[1])

    clickButtonAt(container, 'Markdown', 0)
    expect(onExportSession).toHaveBeenCalledWith(sessions[0], 'markdown')

    clickButtonAt(container, 'PDF', 1)
    expect(onExportSession).toHaveBeenCalledWith(sessions[1], 'pdf')

    clickButtonAt(container, 'Archive', 1)
    expect(onArchiveSession).toHaveBeenCalledWith(sessions[1])

    clickButtonAt(container, 'Delete', 0)
    expect(onDeleteSession).toHaveBeenCalledWith(sessions[0])
  })

  it('renders Files directly after New and wires it to the preview opener', () => {
    const onOpenFiles = vi.fn()
    const container = renderSidebarDom({
      projectName: 'Example project',
      sessions: [createSession({ id: 'session-a', title: 'Notebook review' })],
      activeSessionId: 'session-a',
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: true,
      onOpenFiles,
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: true,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onExportSession: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })
    const buttons = Array.from(container.querySelectorAll('button'))
    const newButtonIndex = buttons.findIndex((button) => button.textContent?.trim() === 'New')
    const filesButton = buttons.find((button) => button.textContent?.trim() === 'Files')

    expect(newButtonIndex).toBeGreaterThanOrEqual(0)
    expect(buttons[newButtonIndex + 1]).toBe(filesButton)
    expect(filesButton?.getAttribute('aria-controls')).toBe('right-panel')
    expect(filesButton?.getAttribute('aria-pressed')).toBe('true')

    clickByText(container, 'Files')
    expect(onOpenFiles).toHaveBeenCalledTimes(1)
  })

  it('wires the View notebook menu item to the matching session', () => {
    const sessions = [
      createSession({ id: 'session-a', title: 'Notebook review' }),
      createSession({ id: 'session-b', title: 'Dataset cleanup' })
    ]
    const onViewNotebook = vi.fn()
    const container = renderSidebarDom({
      projectName: 'Example project',
      sessions,
      activeSessionId: sessions[0].id,
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: true,
      onDownloadArtifacts: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onViewNotebook,
      onExportSession: vi.fn(),
      onOpenSettings: vi.fn()
    })

    clickButtonAt(container, 'View notebook', 1)
    expect(onViewNotebook).toHaveBeenCalledWith(sessions[1])
  })

  it('renders a Pinned section above Active only when a session is pinned', async () => {
    const withoutPins = await renderSidebar([createSession({ id: 'session-a' })])
    expect(withoutPins).not.toContain('>Pinned<')
    expect(withoutPins).toContain('>Active<')

    const withPin = await renderSidebar([
      createSession({ id: 'pinned-session', title: 'Kept handy', pinned: true }),
      createSession({ id: 'plain-session', title: 'Everyday work' })
    ])
    // The pinned header must precede the active header so pinned conversations sit at the top.
    expect(withPin).toContain('>Pinned<')
    expect(withPin.indexOf('>Pinned<')).toBeLessThan(withPin.indexOf('>Active<'))
  })

  it('shows Pin for an unpinned session and Unpin for a pinned one, wired to the session', () => {
    const sessions = [
      createSession({ id: 'session-a', title: 'Unpinned one' }),
      createSession({ id: 'session-b', title: 'Pinned one', pinned: true })
    ]
    const onTogglePin = vi.fn()
    const container = renderSidebarDom({
      projectName: 'Example project',
      sessions,
      activeSessionId: sessions[0].id,
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: true,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onExportSession: vi.fn(),
      onTogglePin,
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })

    // The unpinned session-a shows "Pin"; the pinned session-b shows "Unpin".
    clickButtonAt(container, 'Pin', 0)
    expect(onTogglePin).toHaveBeenCalledWith(sessions[0])

    onTogglePin.mockClear()
    clickButtonAt(container, 'Unpin', 0)
    expect(onTogglePin).toHaveBeenCalledWith(sessions[1])
  })

  it('keeps target-validated deletion available while other mutations are recovering', () => {
    const session = createSession({ id: 'session-a', title: 'Notebook review' })
    const container = renderSidebarDom({
      projectName: 'Example project',
      sessions: [session],
      activeSessionId: session.id,
      canCreateConversation: false,
      canMutateConversations: false,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: true,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })

    expect(findAllByText(container, 'Pin')[0]?.disabled).toBe(true)
    expect(findAllByText(container, 'Rename…')[0]?.disabled).toBe(true)
    expect(findAllByText(container, 'Delete')[0]?.disabled).toBe(false)
  })

  it('disables conversation export for running, waiting-permission, or empty sessions', () => {
    const container = renderSidebarDom({
      projectName: 'Example project',
      sessions: [
        createSession({ id: 'running', status: 'running', messages: [createMessage()] }),
        createSession({
          id: 'waiting',
          status: 'waiting-permission',
          messages: [createMessage()]
        }),
        createSession({ id: 'empty', status: 'idle', messages: [] }),
        createSession({ id: 'ready', status: 'idle', messages: [createMessage()] })
      ],
      activeSessionId: 'ready',
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: false,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onExportSession: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })
    const exportTriggers = findAllByText(container, 'Export conversation')

    expect(exportTriggers).toHaveLength(4)
    expect(exportTriggers[0]?.disabled).toBe(true)
    expect(exportTriggers[1]?.disabled).toBe(true)
    expect(exportTriggers[2]?.disabled).toBe(true)
    expect(exportTriggers[3]?.disabled).toBe(false)
  })

  it('hides conversation export when the runtime does not expose that capability', () => {
    const container = renderSidebarDom({
      projectName: 'Example project',
      sessions: [createSession({ status: 'idle', messages: [createMessage()] })],
      activeSessionId: 'session-1',
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: false,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })

    expect(container.textContent).not.toContain('Export conversation')
  })

  it('hides artifact downloads when the runtime does not provide the desktop save capability', () => {
    const session = createSession({ id: 'session-a', title: 'Notebook review' })
    const container = renderSidebarDom({
      projectName: 'Example project',
      sessions: [session],
      activeSessionId: session.id,
      canCreateConversation: true,
      canMutateConversations: true,
      canDeleteConversations: true,
      onGoHome: vi.fn(),
      onNewConversation: vi.fn(),
      isFilesOpen: false,
      onOpenFiles: vi.fn(),
      onOpenSession: vi.fn(),
      onRenameSession: vi.fn(),
      canDownloadArtifacts: false,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onTogglePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onOpenSettings: vi.fn()
    })

    expect(container.textContent).not.toContain('Download all artifacts')
  })
})
