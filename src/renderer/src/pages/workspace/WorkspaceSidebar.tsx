import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  Download,
  Files,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { cn } from '@/lib/utils'
import { LanguageToggleButton } from '@/components/LanguageToggleButton'
import { useLanguage } from '@/i18n'
import { useSessionStore } from '@/stores/session-store'
import { NetworkStatusIndicator } from '@/components/NetworkStatusIndicator'
import { UpdateCapsule } from '@/components/UpdateCapsule'
import { NotificationBell } from '@/components/NotificationBell'
import { SessionHoverCard, type SessionHoverAnchor } from './SessionHoverCard'
import type { ChatSession, SessionStatus } from '@/stores/session-store'
import type { Project } from '../../../../shared/projects'

type WorkspaceSidebarProps = {
  projectName: string
  projects: Project[]
  activeProjectId: string | undefined
  onSwitchProject: (projectId: string) => void
  sessions: ChatSession[]
  activeSessionId: string | undefined
  canCreateConversation: boolean
  canMutateConversations: boolean
  canDeleteConversations: boolean
  onGoHome: () => void
  onNewConversation: () => void
  isFilesOpen: boolean
  onOpenFiles: () => void
  onOpenSession: (sessionId: string) => void
  onRenameSession: (session: ChatSession) => void
  canDownloadArtifacts: boolean
  onDownloadArtifacts: (session: ChatSession) => void
  onViewNotebook: (session: ChatSession) => void
  onOpenExportDialog?: (session: ChatSession) => void
  onTogglePin: (session: ChatSession) => void
  canArchiveSession?: (session: ChatSession) => boolean
  onArchiveSession?: (session: ChatSession) => void
  onDeleteSession: (session: ChatSession) => void
  onOpenSettings: () => void
  mobileMode?: boolean
  isMobileOpen?: boolean
  onMobileClose?: () => void
}

// Maps each session status to the left-side indicator dot using emitted theme colors.
const sessionStatusDotClassName: Record<SessionStatus, string> = {
  idle: 'border border-text-100 bg-transparent',
  running: 'bg-session-running ring-2 ring-session-running/20',
  'waiting-permission': 'bg-session-waiting ring-2 ring-session-waiting/25',
  'waiting-plan-approval': 'bg-session-waiting ring-2 ring-session-waiting/25',
  error: 'bg-destructive'
}

const sessionStatusLabel: Record<SessionStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  'waiting-permission': 'Waiting for permission',
  'waiting-plan-approval': 'Waiting for plan approval',
  error: 'Error'
}

const sidebarInteractiveTransitionClassName = 'transition-colors duration-200 ease-out'

// Hover card timing: a deliberate dwell opens it, a short grace closes it. Fast sweeps across
// the list never flash a card because the open delay outlasts the dwell on each row.
const SESSION_HOVER_OPEN_DELAY_MS = 250
const SESSION_HOVER_CLOSE_DELAY_MS = 150

const sessionRowClassName = cn(
  'group mx-1.5 select-none rounded-md px-2.5 py-1.5 text-sm text-text-000 hover:bg-bg-300',
  sidebarInteractiveTransitionClassName
)

const sessionRowActionClassName =
  'relative -mr-1 rounded p-0.5 text-text-100 opacity-0 transition-[opacity,color,background-color] duration-200 ease-out hover:!opacity-100 hover:bg-bg-400 hover:text-text-000 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100'

// Shared icon wrapper inside each menu item row.
const sessionMenuIconClassName = 'flex size-4 shrink-0 items-center justify-center'

// Left navigation owns session selection, creation entry, and workspace settings.
const WorkspaceSidebar = ({
  projectName,
  projects,
  activeProjectId,
  onSwitchProject,
  sessions,
  activeSessionId,
  canCreateConversation,
  canMutateConversations,
  canDeleteConversations,
  onGoHome,
  onNewConversation,
  isFilesOpen,
  onOpenFiles,
  onOpenSession,
  onRenameSession,
  canDownloadArtifacts,
  onDownloadArtifacts,
  onViewNotebook,
  onOpenExportDialog,
  onTogglePin,
  canArchiveSession,
  onArchiveSession,
  onDeleteSession,
  onOpenSettings,
  mobileMode = false,
  isMobileOpen = false,
  onMobileClose
}: WorkspaceSidebarProps): React.JSX.Element => {
  const { t } = useLanguage()
  const lastReadAtBySession = useSessionStore((state) => state.lastReadAtBySession)
  // A session has unseen activity when it changed after the user last opened it (or was never opened).
  const isUnread = (session: ChatSession): boolean => {
    if (session.id === activeSessionId) return false
    const lastReadAt = lastReadAtBySession[session.id]
    return lastReadAt === undefined ? session.updatedAt > 0 : session.updatedAt > lastReadAt
  }
  // Partition sessions into pinned and unpinned groups; each group preserves the incoming order.
  const pinnedSessions = sessions.filter((s) => s.pinned)
  const activeSessions = sessions.filter((s) => !s.pinned)

  // Session hover preview card: one card at a time, anchored to the row under the pointer.
  const [hoverState, setHoverState] = useState<{
    session: ChatSession
    anchor: SessionHoverAnchor
  } | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const clearHoverTimers = useCallback((): void => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    openTimerRef.current = null
    closeTimerRef.current = null
  }, [])

  useEffect(() => clearHoverTimers, [clearHoverTimers])

  const closeHoverCard = useCallback((): void => {
    clearHoverTimers()
    setHoverState(null)
  }, [clearHoverTimers])

  // A deliberate dwell opens the card; sweeping across a list of rows must not flash it.
  const scheduleHoverOpen = useCallback((session: ChatSession, element: HTMLElement): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (openTimerRef.current !== null) return
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      const rect = element.getBoundingClientRect()
      setHoverState({
        session,
        anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
      })
    }, SESSION_HOVER_OPEN_DELAY_MS)
  }, [])

  const scheduleHoverClose = useCallback((): void => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setHoverState(null)
    }, SESSION_HOVER_CLOSE_DELAY_MS)
  }, [])

  // Scrolling the list invalidates every anchored position; dismiss the card immediately.
  const handleSessionListScroll = useCallback((): void => {
    closeHoverCard()
  }, [closeHoverCard])

  // A window resize can move the anchor row; dismiss rather than float detached.
  useEffect(() => {
    if (!hoverState) return
    window.addEventListener('resize', closeHoverCard)
    return () => window.removeEventListener('resize', closeHoverCard)
  }, [hoverState, closeHoverCard])

  // Switching sessions changes the row set; never keep a card for a row that may unmount.
  const visibleHoverState =
    hoverState && hoverState.session.id === activeSessionId ? hoverState : null

  // Build section descriptors so the list renders with a labelled header per group.
  const sections: Array<{ label: string; items: typeof sessions }> = []

  if (pinnedSessions.length > 0) sections.push({ label: 'Pinned', items: pinnedSessions })
  sections.push({ label: 'Active', items: activeSessions })

  return (
    <aside
      aria-label={t('sidebar.workspaceNav')}
      aria-hidden={mobileMode && !isMobileOpen ? true : undefined}
      inert={mobileMode && !isMobileOpen ? true : undefined}
      data-mobile-open={isMobileOpen ? 'true' : 'false'}
      className={cn(
        mobileMode
          ? 'fixed inset-y-0 left-0 z-[70] flex h-[100dvh] w-[min(86vw,320px)] min-w-0 shrink-0 flex-col bg-bg-10 transition-transform duration-200 ease-out'
          : 'z-10 flex h-full w-full min-w-0 flex-col overflow-hidden',
        mobileMode && (isMobileOpen ? 'translate-x-0' : '-translate-x-full')
      )}
    >
      <div className="m-2 flex min-h-0 flex-1 flex-col rounded-lg bg-rail-card-bg shadow-card">
        <div className="px-3 pt-3">
          <div className={cn('flex items-start', mobileMode ? 'gap-2' : 'pr-9')}>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={onGoHome}
                className={cn(
                  'flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-bg-300 hover:text-text-000',
                  sidebarInteractiveTransitionClassName
                )}
              >
                <ChevronLeft className="size-3.5" strokeWidth={2} aria-hidden="true" />
                <span>{t('ws.allProjects')}</span>
              </button>
              <div
                className="mt-1.5 truncate px-1.5 font-serif text-[16px] font-bold tracking-[-0.02em] text-text-000"
                title={projectName}
              >
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-label={t('ws.switchProject')}
                  >
                    <span className="truncate">{projectName}</span>
                    <ChevronDown className="size-3.5 shrink-0 text-text-200" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    side="bottom"
                    className="w-[280px] bg-card"
                    sideOffset={4}
                  >
                    {projects
                      .filter((project) => project.id !== activeProjectId)
                      .slice(0, 5)
                      .map((project) => (
                        <DropdownMenuItem
                          key={project.id}
                          onSelect={() => onSwitchProject(project.id)}
                          className="flex flex-col items-start gap-0.5 py-2"
                        >
                          <span className="w-full truncate text-sm font-medium text-foreground">
                            {project.name}
                          </span>
                          {project.description ? (
                            <span className="w-full truncate text-xs text-muted-foreground">
                              {project.description}
                            </span>
                          ) : null}
                        </DropdownMenuItem>
                      ))}
                    {projects.length - 1 > 5 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={onGoHome} className="py-2">
                          <span className="text-sm text-muted-foreground">
                            {t('ws.moreProjects', { count: projects.length - 6 })}
                          </span>
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={onGoHome} className="py-2">
                      <Check className="size-4 text-muted-foreground" aria-hidden="true" />
                      <span className="text-sm">{t('ws.allProjects')}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            {mobileMode ? (
              <button
                type="button"
                onClick={onMobileClose}
                className="grid size-8 shrink-0 place-items-center rounded-lg text-text-300 hover:bg-bg-300 hover:text-text-000"
                aria-label={t('sidebar.closeNav')}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        <nav aria-label="Sessions" className="flex min-h-0 flex-1 flex-col">
          {/* New stays disabled until persistence hydration has reconciled restored sessions. */}
          <div className="flex h-9 items-center gap-1 px-2">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-text-000 hover:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
                sidebarInteractiveTransitionClassName
              )}
              disabled={!canCreateConversation}
              onClick={onNewConversation}
            >
              <span
                className="flex size-3.5 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                <Plus className="size-3.5" strokeWidth={2} />
              </span>
              <span>{t('common.new')}</span>
            </button>
          </div>
          <div className="flex h-9 items-center gap-1 px-2">
            <button
              type="button"
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-text-000 hover:bg-bg-300 disabled:cursor-not-allowed disabled:opacity-50',
                isFilesOpen && 'bg-bg-300',
                sidebarInteractiveTransitionClassName
              )}
              disabled={!canCreateConversation}
              aria-controls="right-panel"
              aria-pressed={isFilesOpen}
              onClick={onOpenFiles}
            >
              <span
                className="flex size-3.5 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                <Files className="size-3.5" strokeWidth={2} />
              </span>
              <span>{t('common.files')}</span>
            </button>
          </div>

          <div className="mx-2 my-1 h-px bg-border-300/15" />

          <div className="min-h-0 flex-1 overflow-y-auto py-1" onScroll={handleSessionListScroll}>
            {sections.map((section) => (
              <div key={section.label}>
                <div className="px-2 pb-[5px] pt-3.5 text-[11px] font-medium text-muted-foreground">
                  {section.label}
                </div>
                {section.items.map((session) => {
                  const isActive = session.id === activeSessionId
                  const isExportDisabled =
                    session.messages.length === 0 ||
                    session.status === 'running' ||
                    session.status === 'waiting-permission'

                  return (
                    <div
                      key={session.id}
                      className={cn(sessionRowClassName, isActive && 'bg-bg-300 text-text-000')}
                      onMouseEnter={(event) => scheduleHoverOpen(session, event.currentTarget)}
                      onMouseLeave={scheduleHoverClose}
                      onFocus={(event) => scheduleHoverOpen(session, event.currentTarget)}
                      onBlur={scheduleHoverClose}
                    >
                      <div className="flex w-full min-w-0 items-center gap-1.5">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => onOpenSession(session.id)}
                        >
                          <span
                            className="inline-flex size-3 shrink-0 items-center justify-center"
                            aria-hidden="true"
                          >
                            <span
                              className={cn(
                                'size-[7px] shrink-0 rounded-full',
                                sessionStatusDotClassName[session.status]
                              )}
                            />
                          </span>
                          <span className="sr-only">
                            Session status: {sessionStatusLabel[session.status]}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{session.title}</span>
                          {!isActive && isUnread(session) ? (
                            <span
                              className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[10px] font-medium text-white"
                              aria-label={t('sidebar.unreadContent')}
                            >
                              {t('sidebar.newContent')}
                            </span>
                          ) : null}
                        </button>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className={cn(sessionRowActionClassName, isActive && 'opacity-100')}
                              aria-label={`Open actions for ${session.title}`}
                              onPointerDown={closeHoverCard}
                            >
                              <span
                                className="flex size-3.5 items-center justify-center"
                                aria-hidden="true"
                              >
                                <MoreVertical className="size-3.5" strokeWidth={2} />
                              </span>
                            </button>
                          </DropdownMenuTrigger>
                          {/* Session action menu: uses shadcn default light-surface tokens. */}
                          <DropdownMenuContent
                            aria-label={t('sidebar.sessionActions')}
                            className="min-w-[9rem]"
                            side="right"
                            align="start"
                            sideOffset={6}
                          >
                            {/* Pin / Unpin toggles the conversation into or out of the pinned section. */}
                            <DropdownMenuItem
                              className="gap-2"
                              disabled={!canMutateConversations}
                              onSelect={() => onTogglePin(session)}
                            >
                              <span className={sessionMenuIconClassName}>
                                {session.pinned ? (
                                  <PinOff className="size-4" strokeWidth={2} aria-hidden="true" />
                                ) : (
                                  <Pin className="size-4" strokeWidth={2} aria-hidden="true" />
                                )}
                              </span>
                              {session.pinned ? 'Unpin' : 'Pin'}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2"
                              disabled={!canMutateConversations}
                              onSelect={() => onRenameSession(session)}
                            >
                              <span className={sessionMenuIconClassName}>
                                <Pencil className="size-4" strokeWidth={2} aria-hidden="true" />
                              </span>
                              {t('workspace.rename')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {canDownloadArtifacts ? (
                              <DropdownMenuItem
                                className="gap-2"
                                onSelect={() => onDownloadArtifacts(session)}
                              >
                                <span className={sessionMenuIconClassName}>
                                  <Download className="size-4" strokeWidth={2} aria-hidden="true" />
                                </span>
                                {t('workspace.downloadArtifacts')}
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                              className="gap-2"
                              onSelect={() => onViewNotebook(session)}
                            >
                              <span className={sessionMenuIconClassName}>
                                <BookOpen className="size-4" strokeWidth={2} aria-hidden="true" />
                              </span>
                              {t('workspace.viewNotebook')}
                            </DropdownMenuItem>
                            {onOpenExportDialog ? (
                              <DropdownMenuItem
                                className="gap-2"
                                disabled={isExportDisabled}
                                onSelect={() => onOpenExportDialog(session)}
                              >
                                <span className={sessionMenuIconClassName}>
                                  <Download className="size-4" strokeWidth={2} aria-hidden="true" />
                                </span>
                                <span className="flex-1">{t('workspace.exportConversation')}</span>
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                              className="gap-2"
                              disabled={!canArchiveSession?.(session)}
                              onSelect={() => onArchiveSession?.(session)}
                            >
                              <span className={sessionMenuIconClassName}>
                                <Archive className="size-4" strokeWidth={2} aria-hidden="true" />
                              </span>
                              {t('workspace.archive')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {/* Delete uses the project's danger token pair for light surfaces. */}
                            <DropdownMenuItem
                              className="gap-2 text-danger-000 data-[highlighted]:bg-danger-900 data-[highlighted]:text-danger-000"
                              disabled={!canDeleteConversations}
                              onSelect={() => onDeleteSession(session)}
                            >
                              <span className={sessionMenuIconClassName}>
                                <Trash2 className="size-4" strokeWidth={2} aria-hidden="true" />
                              </span>
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      {/* Self-describing sessions: a summary line under the title. */}
                      {session.description ? (
                        <span className="line-clamp-2 mt-1 w-full whitespace-pre-wrap pl-5 pr-1.5 text-[11px] leading-snug text-muted-foreground">
                          {session.description}
                        </span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          <div className="relative flex shrink-0 items-center gap-1 p-2">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-rail-card-bg to-rail-card-bg/0"
            />
            <NotificationBell side="top" align="start" />
            <button
              type="button"
              onClick={onOpenSettings}
              className={cn(
                'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-text-300 hover:bg-bg-300 hover:text-text-000',
                sidebarInteractiveTransitionClassName
              )}
              aria-label="Settings"
            >
              <Settings className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
            <UpdateCapsule />
            <LanguageToggleButton />
            <NetworkStatusIndicator variant="icon" />
          </div>
        </nav>
      </div>
      {visibleHoverState ? (
        <SessionHoverCard session={visibleHoverState.session} anchor={visibleHoverState.anchor} />
      ) : null}
    </aside>
  )
}

export { WorkspaceSidebar }
