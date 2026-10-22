// @vitest-environment jsdom
// 一个**没有计划**的会话被打开时，页面会向主进程问一次「这个会话有计划吗」。这个问题的答案只与
// 「打开的是哪个会话」有关（外加一种状态迁移，见最后一条用例），而 `activeSession` 这个对象在每一次
// 工具活动、每一条流式 delta 之后都会被 store 换成新身份 —— 于是那个 effect 每一帧都重问一次，
// 主进程每一次都要进全局持久化队列、把会话 JSON 重新读一遍并解析。
//
// 真机读数（`logs/headless.out.log`，开发实例，`[ipc] ipc handler was slow` 阈值 50ms）：
// `acp:get-plan-projection` **726 条**，中位 3,825ms、最大 125,341ms —— 是除保存与 notebook 状态之外
// 调用次数最多的读通道，而它唯一的生产调用方就是下面这个 effect。
//
// 本文件钉住三件事（每条都能单独把修法打红）：
//   1. 打开一个没有计划的会话 ⇒ 只问一次；
//   2. 同一会话随后收到 N 次工具活动（store 换新对象）⇒ **不再问**；
//   3. 会话**状态真的变了**（进入等批准）⇒ 仍然再问一次，并且 main 说没有计划时把卡住的状态解开 ——
//      这是修复路线，不许被「只问一次」顺手关掉；
//   4. 切走再切回来算一次新的「打开」⇒ 会再问一次（免得把「只问一次」做成「问过就永远不问」）。
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'

import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useProjectStore } from '@/stores/project-store'
import { createInitialReviewState, useReviewStore } from '@/stores/review-store'
import {
  createInitialSessionState,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'

import { type ComposerDoc } from './composer/composer-doc'

type ConversationProps = {
  draftDoc: ComposerDoc
  canEditDraft: boolean
  canSendMessage: boolean
  canEditMessage: boolean
  canChangeAgentControls: boolean
  canChangePermissionProfile: boolean
  canCompactContext: boolean
  compactContextDisabledReason?: string
  onDraftDocChange: (doc: ComposerDoc) => void
  onSendMessage: (forcedSkillIds: string[]) => void
  onRespondToRestoredPlan: (
    response: { decision: 'approved' | 'rejected' } | { feedback: string }
  ) => Promise<void>
}

let conversationProps: ConversationProps

const runtime = vi.hoisted(() => ({
  promptInFlightSessionIds: [] as string[],
  sendPreparationInFlightSessionIds: [] as string[],
  nativeContextCompactionSessionIds: [] as string[],
  sendMessage: vi.fn(),
  compactContext: vi.fn(),
  cancelRun: vi.fn(),
  deleteRuntimeSession: vi.fn(),
  respondToPermission: vi.fn()
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizableHandle: (): React.JSX.Element => <div data-testid="resize-handle" />
}))

vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  useWorkspaceAgentRuntime: () => ({
    actionError: null,
    pendingPermissions: [],
    promptInFlightSessionIds: runtime.promptInFlightSessionIds,
    sendPreparationInFlightSessionIds: runtime.sendPreparationInFlightSessionIds,
    nativeContextCompactionSessionIds: runtime.nativeContextCompactionSessionIds,
    sendMessage: runtime.sendMessage,
    compactContext: runtime.compactContext,
    cancelRun: runtime.cancelRun,
    deleteRuntimeSession: runtime.deleteRuntimeSession,
    respondToPermission: runtime.respondToPermission
  })
}))

vi.mock('./WorkspaceSidebar', () => ({
  WorkspaceSidebar: (): React.JSX.Element => <aside />
}))

vi.mock('./ConversationPanel', () => ({
  ConversationPanel: (props: ConversationProps): React.JSX.Element => {
    conversationProps = props
    return <section data-testid="conversation" />
  }
}))

vi.mock('./PreviewPanel', () => ({
  PreviewPanel: (): React.JSX.Element => <div data-testid="preview-panel" />
}))

vi.mock('./RenameSessionDialog', () => ({
  RenameSessionDialog: (): React.JSX.Element => <div />
}))

vi.mock('./DeleteSessionDialog', () => ({
  DeleteSessionDialog: (): React.JSX.Element => <div />
}))

const { WorkspacePage } = await import('./WorkspacePage')

const createSession = (overrides: Partial<ChatSession> = {}): ChatSession => {
  const now = Date.now()
  return {
    id: 'sess-a',
    projectId: 'proj-1',
    title: 'sess-a',
    cwd: '/workspace/proj-1',
    status: 'idle',
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

const getPlanProjection = vi.fn(() => Promise.resolve(null))

describe('WorkspacePage asks the Plan projection question once per opening', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useProjectStore.setState({ projects: [] })
    useReviewStore.setState(createInitialReviewState())
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [createSession()],
      selectedSessionId: 'sess-a'
    })
    getPlanProjection.mockClear()
    getPlanProjection.mockImplementation(() => Promise.resolve(null))
    runtime.promptInFlightSessionIds = []
    runtime.sendPreparationInFlightSessionIds = []
    runtime.nativeContextCompactionSessionIds = []

    window.api = {
      acp: { getPlanProjection },
      notebook: {
        onAvailable: vi.fn(() => vi.fn()),
        getReference: vi.fn(() => Promise.resolve(null))
      },
      preview: {
        load: vi.fn(() => Promise.resolve(undefined)),
        save: vi.fn(() => Promise.resolve())
      },
      uploads: { deleteUpload: vi.fn() },
      reviewer: {
        onUpdated: vi.fn(() => vi.fn()),
        onSuppressNextAutoReview: vi.fn(() => vi.fn()),
        onFixLoopStart: vi.fn(() => vi.fn()),
        onFixLoopEnd: vi.fn(() => vi.fn()),
        abortFixLoop: vi.fn(() => Promise.resolve())
      },
      compute: { enabledHostsSet: vi.fn(() => Promise.resolve()) }
    } as never

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  const renderPage = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })
    // The ask is a promise; wait for the projection to be applied (or for the null repair to settle).
    await act(async () => {
      await Promise.resolve()
    })
  }

  const askCount = (): number => getPlanProjection.mock.calls.length

  it('asks once when a session without a Plan is opened', async () => {
    await renderPage()

    expect(askCount()).toBe(1)
    expect(getPlanProjection).toHaveBeenCalledWith('proj-1', 'sess-a')
  })

  it('does not ask again when the same session receives unrelated activity', async () => {
    // 一次真实回合里，工具活动会挂在提问消息上（`projectToolActivity` 对没有已知提问的活动**按设计**
    // 不动 store），所以这里给一条 user 消息，让这五次活动是真的写入而不是空操作。
    const prompt = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'analyze',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    useSessionStore.setState({
      sessions: [createSession({ status: 'running', messages: [prompt] })],
      selectedSessionId: 'sess-a'
    })
    await renderPage()
    expect(askCount()).toBe(1)
    const sessionBefore = useSessionStore.getState().sessions[0]

    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        useSessionStore.getState().upsertToolActivity({
          sessionId: 'sess-a',
          promptMessageId: 'prompt-1',
          toolCallId: `tool-${index}`,
          eventId: `event-${index}`,
          providerToolName: 'Read',
          status: 'pending'
        })
      }
    })

    // 先证明这五次活动**真的改了状态**：否则「只问了一次」可能只是因为它什么都没做（假绿）。
    const sessionAfter = useSessionStore.getState().sessions[0]
    expect(sessionAfter).not.toBe(sessionBefore)
    expect(sessionAfter?.activities?.length ?? 0).toBeGreaterThanOrEqual(5)

    expect(askCount()).toBe(1)
  })

  it('asks again when the session really changes state, and still repairs a stuck waiting status', async () => {
    await renderPage()
    expect(askCount()).toBe(1)

    await act(async () => {
      useSessionStore.setState({
        sessions: [createSession({ status: 'waiting-plan-approval' })],
        selectedSessionId: 'sess-a'
      })
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(askCount()).toBe(2)
    expect(useSessionStore.getState().sessions[0]?.status).toBe('idle')
  })

  it('asks again after switching away and back, because that is a new opening', async () => {
    useSessionStore.setState({
      sessions: [createSession(), createSession({ id: 'sess-b', title: 'sess-b' })],
      selectedSessionId: 'sess-a'
    })
    await renderPage()
    expect(askCount()).toBe(1)

    await act(async () => {
      useSessionStore.getState().selectSession('sess-b')
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(getPlanProjection).toHaveBeenCalledWith('proj-1', 'sess-b')

    const afterSwitchAway = askCount()
    await act(async () => {
      useSessionStore.getState().selectSession('sess-a')
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(askCount()).toBe(afterSwitchAway + 1)
    expect(getPlanProjection).toHaveBeenLastCalledWith('proj-1', 'sess-a')
    // 面板真的渲染出来了（这条用例的读数不是「什么都没发生」）
    expect(conversationProps.canEditDraft).toBe(true)
  })
})
