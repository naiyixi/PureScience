// @vitest-environment jsdom
//
// U33 instrument — how far a single streamed delta propagates through the real subscriber → panel →
// transcript chain.
//
// Why a separate harness exists at all (see docs/plan-2026-09-23-entry-layer-optimization.md, "U33 仪器
// 落点：现成 harness 全部不可用"): `ConversationPanel.interaction.test.tsx` replaces the transcript with
// `vi.mock('./WorkspaceMessageScroller')` (it was written for composer intake), and every
// `WorkspacePage.*.test.tsx` replaces the panel with `vi.mock('./ConversationPanel')`. Nothing in the
// repo rendered the real panel *and* the real scroller against the real store, so "who re-renders per
// delta" had no instrument.
//
// This file is that harness: it copies the panel's full prop list from `ConversationPanel.interaction
// .test.tsx` and drops only the scroller mock. It renders the real `ConversationPanel`, the real
// `WorkspaceMessageScroller` and the real `WorkspaceMessageItem`, driven by the store's real streaming
// entry point (`appendAgentMessageChunk`), and counts renders at three levels:
//
//   panel    — React `<Profiler>` around `ConversationPanel`;
//   scroller — the `MessageScrollerProvider` element the scroller mounts (its function body ran);
//   leaf     — a `memo`-preserving wrapper around `WorkspaceMessageItem`, recording *which* slot
//              re-rendered (the same shallow comparison the real memoised item uses).
//
// The frame metrics cannot see any of this: each slot's work is small, so no single task crosses the
// 50ms long-task threshold even when the whole transcript re-renders (docs/evidence/2026-09-25
// -interaction-smoothness.md). Render counts answer it deterministically, in CI.
import { Profiler, act, memo, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationPanel } from './ConversationPanel'
import { emptyDoc, type ComposerDoc } from './composer/composer-doc'
import { useSessionStore, type ChatMessage, type ChatSession } from '@/stores/session-store'
import { useRenderSessions } from './use-render-sessions'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Counters live in a hoisted object so the (hoisted) module factories below can reach them.
const instrument = vi.hoisted(() => ({
  // `vi.fn()` rather than a counter object: the mock components below call these during render, and the
  // lint rule that forbids mutating outer-scope values from a component body is right — a recorded call is
  // a side effect with a name, the `.mock.calls` are what the assertions read.
  // `panel` and `scroller` count the *bodies* of the two containers: each is a small child element the
  // container mints on every one of its own renders, so a skipped render is visible as a missing render
  // here. The `<Profiler>` number is reported next to them for comparison, but React calls `onRender` for
  // a commit that only re-created the element even when the memoised component bailed out, so it is not
  // the signal to assert on.
  panel: vi.fn(),
  scroller: vi.fn(),
  profiler: vi.fn(),
  leaf: vi.fn(),
  markdown: vi.fn(),
  // Which icon components the chunk re-rendered. The icons live in the app's own chrome, so counting them
  // by name says *which* component came along with the text (the profile only says "a lucide icon frame").
  icon: vi.fn()
}))

// Every `MessageTimestamp` render formats its date with Intl and stamps `toISOString()` onto the <time>
// element, so counting that call is a deterministic proxy for "how many timestamps re-rendered". Patched
// for the duration of a test only, and reset by `resetInstrument` like the other counters.
const timestampProbe = { renders: 0 }
let originalToISOString: Date['toISOString'] | undefined

const resetInstrument = (): void => {
  for (const counter of Object.values(instrument)) counter.mockClear()
  timestampProbe.renders = 0
}

const panelRenderCount = (): number => instrument.panel.mock.calls.length
const scrollerRenderCount = (): number => instrument.scroller.mock.calls.length
const profilerRenderCount = (): number => instrument.profiler.mock.calls.length
const renderedSlotIds = (): string[] => instrument.leaf.mock.calls.map(([id]) => String(id))
const renderedMarkdown = (): string[] =>
  instrument.markdown.mock.calls.map(([text]) => String(text))

const renderedIcons = (): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const [name] of instrument.icon.mock.calls) {
    const key = String(name)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

// Child regions pull in stores/UI unrelated to the transcript, so stub them to plain markers.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>
}))

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' '),
  formatByteSize: (size: number | undefined) =>
    typeof size === 'number' && size >= 0 ? `${size} B` : undefined
}))

// Radix DropdownMenu calls pointer-capture APIs that jsdom does not implement.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: (): React.JSX.Element => <hr />,
  DropdownMenuItem: ({
    children,
    ...rest
  }: PropsWithChildren<Record<string, unknown>>): React.JSX.Element => (
    <div {...rest}>{children}</div>
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  Tooltip: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  TooltipContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <span data-testid="tooltip-content">{children}</span>
  )
}))

vi.mock('./ComposerModelPicker', () => ({
  ComposerModelPicker: (): null => null
}))

vi.mock('./ComposerAgentControlsMenu', () => ({
  ComposerAgentControlsMenu: (): null => null
}))

vi.mock('@/components/RemoteJobBadge', () => ({
  RemoteJobBadge: (): null => null
}))

// The panel's always-rendered child: its render count *is* "the panel's body ran" (see the counters).
vi.mock('./TrimmedHistoryNotice', () => ({
  TrimmedHistoryNotice: (): React.JSX.Element => {
    instrument.panel()
    return <div data-testid="trimmed-history-notice" />
  }
}))

vi.mock('./PermissionApprovalControls', () => ({
  PermissionApprovalControls: (): null => null
}))

vi.mock('./session-plan/respond-to-session-plan', () => ({
  respondToSessionPlan: vi.fn().mockResolvedValue(undefined)
}))

// pdfjs-dist references DOMMatrix at module load, which jsdom does not provide.
vi.mock('pdfjs-dist', () => {
  class PDFDataRangeTransport {
    requestAllRanges(): void {
      /* no-op */
    }
  }
  return {
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 0, destroy: () => undefined }),
      destroy: () => undefined
    }),
    GlobalWorkerOptions: { workerSrc: '' },
    PDFDataRangeTransport,
    version: 'test'
  }
})

vi.mock('@/lib/session-persistence/session-persistence', () => ({
  flushSessionPersistence: vi.fn(async (): Promise<void> => undefined)
}))

// Leaf body counter: every settled or streaming agent slot that reaches its Markdown body.
vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }): React.JSX.Element => {
    instrument.markdown(String(content))
    return <div>{content}</div>
  }
}))

// Icon probe: `lucide-react` is a name-to-component map, so a counting stand-in for every icon export
// reports exactly which icons rendered (non-component exports keep their real value so nothing else breaks).
vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()

  const countingIcon = (name: string): React.ComponentType<Record<string, unknown>> => {
    const Icon = ({ ...rest }: Record<string, unknown>): React.JSX.Element => {
      instrument.icon(name)
      return <span data-icon={name} {...rest} />
    }
    Icon.displayName = name
    return Icon
  }

  const probe: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(actual)) {
    const isIconComponent =
      typeof value === 'object' && value !== null && '$$typeof' in (value as object)
    probe[name] = isIconComponent ? countingIcon(name) : value
  }

  return probe
})

// Everything is visible in tests: the bounded-render window collapses to the full transcript. The
// provider wrapper doubles as the container counter — the scroller mints that element on every render
// of its own body, so the count *is* "the list container re-rendered".
vi.mock('@/components/ui/message-scroller', () => {
  const Wrapper = ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>
  const Provider = ({ children }: PropsWithChildren): React.JSX.Element => {
    instrument.scroller()
    return <div>{children}</div>
  }
  const Item = ({
    children,
    messageId
  }: PropsWithChildren<{ messageId?: string }>): React.JSX.Element => (
    <div data-message-id={messageId}>{children}</div>
  )
  const Button = (): React.JSX.Element => <button type="button">Scroll to end</button>

  const useMessageScrollerVisibility = (): {
    currentAnchorId: string | null
    visibleMessageIds: string[]
  } => ({ currentAnchorId: null, visibleMessageIds: [] })
  const useMessageScroller = (): {
    scrollToEnd: () => boolean
    scrollToMessage: () => boolean
    scrollToStart: () => boolean
  } => ({ scrollToEnd: () => false, scrollToMessage: () => false, scrollToStart: () => false })

  return {
    MessageScrollerProvider: Provider,
    MessageScroller: Wrapper,
    MessageScrollerViewport: Wrapper,
    MessageScrollerContent: Wrapper,
    MessageScrollerItem: Item,
    MessageScrollerButton: Button,
    useMessageScroller,
    useMessageScrollerVisibility
  }
})

// Slot counter: an added layer that keeps the real item's own memoisation (shallow compare on the same
// props), so the recorded ids are exactly the slots React actually re-rendered.
vi.mock('./WorkspaceMessageItem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./WorkspaceMessageItem')>()
  const InstrumentedSlot = memo(function InstrumentedSlot(
    props: Parameters<typeof actual.WorkspaceMessageItem>[0]
  ): React.JSX.Element {
    instrument.leaf(props.message.id)
    return <actual.WorkspaceMessageItem {...props} />
  })
  return { ...actual, WorkspaceMessageItem: InstrumentedSlot }
})

type PanelProps = Parameters<typeof ConversationPanel>[0]

// Stable handler identities: the workspace passes durable callbacks, and inline `vi.fn()`s would make
// the measurement read the harness rather than the app.
const stableHandlers = {
  onStageAttachmentFiles: vi.fn(),
  onRespondToElicitation: vi.fn(),
  onRespondToEgressApproval: vi.fn(),
  onRemoveAnnotation: vi.fn(),
  onAnnotateSelection: vi.fn(),
  onDraftDocChange: vi.fn(),
  onSendMessage: vi.fn(),
  onRespondToRestoredPlan: vi.fn().mockResolvedValue(undefined),
  onRemoveAttachment: vi.fn(),
  onCancelAttachmentTransfer: vi.fn(),
  onCancelRun: vi.fn(),
  onResumeSession: vi.fn().mockResolvedValue(undefined),
  onContinueSession: vi.fn().mockResolvedValue(undefined),
  onOpenNotebook: vi.fn(),
  onRespondToPermission: vi.fn(),
  onPermissionProfileChange: vi.fn(),
  onRevokePermissionGrant: vi.fn(),
  onClearPermissionGrants: vi.fn(),
  onAutoReviewToggle: vi.fn(),
  onComputeHostToggle: vi.fn(),
  onRequestReview: vi.fn(),
  onSendEditedMessage: vi.fn()
}

const panelProps: Omit<PanelProps, 'activeSession'> = {
  draftDoc: emptyDoc,
  canSendMessage: false,
  canEditDraft: true,
  canResumeSession: true,
  actionError: null,
  attachments: [],
  attachmentTransfers: [],
  isUploadingAttachments: false,
  notebookReference: undefined,
  pendingPermissions: [],
  pendingElicitations: [],
  pendingEgressApprovals: [],
  pendingAnnotations: [],
  permissionProfile: 'ask',
  permissionProfileState: undefined,
  permissionGrants: [],
  contextUsage: undefined,
  canChangeAgentControls: true,
  canChangePermissionProfile: true,
  autoReviewEnabled: true,
  enabledComputeHosts: [],
  isRequestReviewDisabled: false,
  canEditMessage: true,
  ...stableHandlers
}

const SESSION_ID = 'session-stream'
const STREAM_ID = 'stream-1'
const SETTLED_MESSAGE_COUNT = 40

const createMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt',
  status: 'complete',
  eventIds: [],
  createdAt: 1_710_000_000_000,
  updatedAt: 1_710_000_000_000,
  ...overrides
})

// A long conversation (the shape the smoothness complaint is about). The turn that streams is opened by
// the first delta the test pushes, exactly as the app's projection creates it.
const createStreamingSession = (): ChatSession => {
  const messages: ChatMessage[] = []
  for (let index = 0; index < SETTLED_MESSAGE_COUNT; index += 1) {
    const isUser = index % 2 === 0
    messages.push(
      createMessage({
        id: isUser ? `prompt-${index}` : `reply-${index}`,
        role: isUser ? 'user' : 'agent',
        content: isUser ? `Question ${index}` : `Answer ${index}`,
        responseToMessageId: isUser ? undefined : `prompt-${index - 1}`,
        createdAt: 1_710_000_000_000 + index
      })
    )
  }

  return {
    id: SESSION_ID,
    projectId: 'project-a',
    title: 'Streaming session',
    cwd: '/workspace',
    status: 'running',
    activeRun: { promptMessageId: `prompt-${SETTLED_MESSAGE_COUNT - 2}`, startedAt: 1 },
    messages,
    createdAt: 1_710_000_000_000,
    updatedAt: 1_710_000_000_000
  }
}

let container: HTMLDivElement
let root: Root

// The subscription shape the workspace page uses (`useRenderSessions` + `selectedSessionId`, then a
// `useMemo` lookup), so a delta propagates exactly the way it does in the app.
const WorkspaceLikeHost = ({
  draftDoc = emptyDoc
}: {
  draftDoc?: ComposerDoc
}): React.JSX.Element => {
  const sessions = useRenderSessions()
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [selectedSessionId, sessions]
  )

  return (
    <Profiler
      id="conversation-panel"
      onRender={(): void => {
        instrument.profiler()
      }}
    >
      <ConversationPanel activeSession={activeSession} {...panelProps} draftDoc={draftDoc} />
    </Profiler>
  )
}

const renderHost = (): void => {
  act(() => {
    root.render(<WorkspaceLikeHost />)
  })
}

// One tool-activity update through the store's real entry point (the path a streamed tool event takes).
const pushActivity = (
  toolCallId: string,
  eventIndex: number,
  status: 'pending' | 'completed'
): void => {
  act(() => {
    useSessionStore.getState().upsertToolActivity({
      sessionId: SESSION_ID,
      toolCallId,
      eventId: `event-activity-${eventIndex}`,
      toolKind: 'fetch',
      providerToolName: 'WebSearch',
      title: '"public data repositories"',
      status
    })
  })
}

// One streamed delta through the store's real entry point.
const pushDelta = (index: number, text: string): void => {
  act(() => {
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: SESSION_ID,
      streamId: STREAM_ID,
      eventId: `event-${index}`,
      content: text
    })
  })
}

beforeEach(() => {
  originalToISOString = Date.prototype.toISOString
  Date.prototype.toISOString = function patchedToISOString(this: Date): string {
    timestampProbe.renders += 1
    return originalToISOString?.call(this) ?? ''
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSessionStore.setState({ sessions: [], selectedSessionId: undefined })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  useSessionStore.setState({
    sessions: [createStreamingSession()],
    selectedSessionId: SESSION_ID
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (originalToISOString) Date.prototype.toISOString = originalToISOString
})

describe('ConversationPanel transcript render cost', () => {
  it('characterises how far one streamed delta propagates', () => {
    renderHost()

    // The transcript is really there — otherwise the counters below would be measuring an empty panel.
    expect(container.textContent).toContain('Answer 37')
    expect(container.textContent).not.toContain('partial')

    // The icon probe has to be live before its "no icon re-rendered" reading means anything: the mount
    // renders the transcript's own chrome, so some icon must have rendered by now.
    expect(Object.keys(renderedIcons()).length).toBeGreaterThan(0)

    // The first chunk of a turn is a structural change by definition: it creates the Agent message the
    // run streams into (that is also how the app's own projection shapes it, `images: undefined`
    // included). Measure the chunks after it — the ones that only carry text.
    pushDelta(1, 'partial')
    expect(container.textContent).toContain('partial')

    resetInstrument()
    pushDelta(2, ' more')

    const measured = {
      panel: panelRenderCount(),
      scroller: scrollerRenderCount(),
      profiler: profilerRenderCount(),
      slots: renderedSlotIds(),
      markdown: renderedMarkdown(),
      icons: renderedIcons()
    }

    console.log('[render-count] one delta:', JSON.stringify(measured))

    // The measurement is about the message the chunk actually landed on.
    const streamed = useSessionStore.getState().sessions[0]?.messages.at(-1)
    expect(streamed?.content).toBe('partial more')
    expect(streamed?.status).toBe('streaming')

    // The target: a chunk of text re-renders the one message that renders it, and nothing above it. The
    // panel and the list container hold their props across the chunk (`hasStablePanelInputs` /
    // `carriesSameTranscriptStructure`) and the text travels to the message through its own store
    // subscription, so the whole transcript's element tree is not re-walked for it.
    expect({
      panel: measured.panel,
      scroller: measured.scroller,
      slots: measured.slots,
      markdown: measured.markdown,
      icons: measured.icons
    }).toEqual({
      panel: 0,
      scroller: 0,
      slots: [],
      markdown: ['partial more'],
      // A text chunk re-renders the text and *no icon at all*: the icons in a workspace screen belong to the
      // tool-activity rows and the panel chrome, none of which this chunk changed. Measured rather than
      // assumed — the CPU profile only ever says "a lucide icon frame", with the rendering component's name
      // already lost inside React's work loop.
      icons: {}
    })
  })
  it('characterises what a tool-activity update re-renders', () => {
    renderHost()
    // A run in progress: the first text chunk creates the streaming slot the activity lands next to.
    pushDelta(1, 'partial')
    resetInstrument()

    // A tool event arrives (pending), the way a streamed tool call reaches the store.
    pushActivity('tool-activity-1', 1, 'pending')

    const created = {
      panel: panelRenderCount(),
      scroller: scrollerRenderCount(),
      slots: renderedSlotIds(),
      markdown: renderedMarkdown(),
      icons: renderedIcons()
    }
    console.log('[render-count] activity created:', JSON.stringify(created))

    // The activity channel is handled like the text channel: the panel keeps its props (and so do its eight
    // chrome icons — before this, one activity update dragged all of them along), and the list container
    // re-renders because it owns the timeline. Only the icons that belong to the activity itself render:
    // the row's status icon and the group's chevron.
    expect(created).toEqual({
      panel: 0,
      scroller: 1,
      slots: [],
      markdown: [],
      icons: { ChevronRight: 1, LoaderCircle: 1 }
    })

    // The update has to be *visible* — reading from the store must not leave the row frozen on the snapshot
    // the props carry (the failure mode the text channel hit first).
    expect(container.querySelector('[data-icon="LoaderCircle"]')).not.toBeNull()

    // The same activity changes status: the update an agent emits far more often than a creation.
    resetInstrument()
    pushActivity('tool-activity-1', 2, 'completed')

    const settled = {
      panel: panelRenderCount(),
      scroller: scrollerRenderCount(),
      slots: renderedSlotIds(),
      markdown: renderedMarkdown(),
      icons: renderedIcons()
    }
    console.log('[render-count] activity settled:', JSON.stringify(settled))

    // A status change costs the same as a creation, and the row really swaps its icon in the DOM
    // (`LoaderCircle` → `Check`): the store is the source, not the frozen props.
    expect(settled).toEqual({
      panel: 0,
      scroller: 1,
      slots: [],
      markdown: [],
      icons: { Check: 1, ChevronRight: 1 }
    })

    expect(container.querySelector('[data-icon="Check"]')).not.toBeNull()
    expect(container.querySelector('[data-icon="LoaderCircle"]')).toBeNull()
    expect(container.textContent).toContain('partial')
  })
  it('keeps a composer keystroke out of the transcript', () => {
    renderHost()
    pushDelta(1, 'partial')
    resetInstrument()

    // A keystroke replaces the draft object, which is a WorkspacePage prop — the page-level re-render is
    // expected, the transcript's is not.
    const typed: ComposerDoc = { nodes: [{ type: 'text', text: 'h' }] }
    act(() => root.render(<WorkspaceLikeHost draftDoc={typed} />))

    expect(panelRenderCount()).toBe(1)
    // The expensive part of the panel: none of it may come along for a keystroke.
    expect(scrollerRenderCount()).toBe(0)
    expect(renderedSlotIds()).toEqual([])
    expect(renderedMarkdown()).toEqual([])
    expect(timestampProbe.renders).toBe(0)
    // Only the chrome is allowed to redraw — those icons reflect the draft state the user is editing.
    expect(Object.keys(renderedIcons()).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('partial')
  })

  it('keeps message timestamps out of every hot path', () => {
    renderHost()
    // Live probe check: the transcript really does render timestamps (the settled prompts carry "Sent").
    expect(timestampProbe.renders).toBeGreaterThan(0)

    pushDelta(1, 'partial')
    resetInstrument()
    pushDelta(2, ' more')
    const perDelta = timestampProbe.renders

    resetInstrument()
    pushActivity('tool-activity-timestamp', 1, 'pending')
    const perActivity = timestampProbe.renders

    // A panel render caused by anything else must not drag the timestamps along either.
    resetInstrument()
    act(() => root.render(<WorkspaceLikeHost />))
    const perHostRender = timestampProbe.renders

    // Each of these used to be a place a timestamp could be re-formatted; all three must stay at zero.
    // (Measured cost per timestamp is ~2µs — see docs/evidence — so this is about keeping the invariant,
    // not about a big win.)
    expect(perDelta).toBe(0)
    expect(perActivity).toBe(0)
    expect(perHostRender).toBe(0)
    expect(container.textContent).toContain('partial more')
  })

  it('keeps a long activity timeline to the one row that changed', () => {
    renderHost()
    pushDelta(1, 'partial')
    // A tool-heavy turn: the timeline is already full of settled rows before the next one arrives.
    const settled = 12
    for (let index = 1; index <= settled; index += 1) {
      pushActivity(`tool-activity-${index}`, index, 'completed')
    }
    resetInstrument()

    // One *new* activity arrives while the other twelve are unchanged.
    pushActivity('tool-activity-live', settled + 1, 'pending')
    const arrived = renderedIcons()
    resetInstrument()

    // …and then it settles. The same row has to redraw on its own (a frozen lane would keep the spinner).
    pushActivity('tool-activity-live', settled + 2, 'completed')
    const settledIcons = renderedIcons()

    const measured = {
      panel: panelRenderCount(),
      scroller: scrollerRenderCount(),
      slots: renderedSlotIds(),
      markdown: renderedMarkdown(),
      icons: arrived,
      iconsAfterSettle: settledIcons
    }
    console.log('[render-count] long activity timeline:', JSON.stringify(measured))

    // Only the changing row draws an icon; the twelve settled ones must not redraw at all.
    expect(arrived).toEqual({ ChevronRight: 1, LoaderCircle: 1 })
    expect(settledIcons).toEqual({ ChevronRight: 1, Check: 1 })
    // The activity content itself has to be on screen (icons alone would not prove the row is live).
    expect(container.textContent).toContain('public data repositories')
  })
})
