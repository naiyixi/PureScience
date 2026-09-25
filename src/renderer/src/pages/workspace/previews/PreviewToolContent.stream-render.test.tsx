// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import type { PreviewToolItem } from '@/stores/preview-workbench-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'

// The preview pane's plan surface renders from the session store. It used to read the *Session object*,
// which a streamed chunk replaces several times a second, so the plan preview re-rendered — and re-ran the
// whole plan projection render — for text that belongs to the transcript. This harness measures a chunk's
// reach into it: the probe is the surface the component mints on every one of its own renders.
const instrument = vi.hoisted(() => ({ planSurface: vi.fn() }))

vi.mock('../NotebookPreview', () => ({ NotebookPreview: (): null => null }))
vi.mock('../ProjectFilesView', () => ({ ProjectFilesView: (): null => null }))
vi.mock('../SessionReviewerPanel', () => ({ SessionReviewerPanel: (): null => null }))
vi.mock('../session-plan/SessionPlanSurfaces', () => ({
  PlanPreviewSurface: ({
    projection
  }: {
    projection: { artifactVersionId: string }
  }): React.JSX.Element => {
    instrument.planSurface(projection.artifactVersionId)
    return <div data-testid="plan-surface">{projection.artifactVersionId}</div>
  }
}))

import { PreviewToolContent } from './PreviewToolContent'

const pendingProjection: ActivePlanProjection = {
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'a'.repeat(64),
  revision: 3,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
    task_summary: 'Analyze one dataset',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary agent',
            steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
          }
        ]
      }
    ],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  stepStates: { 'Analyze the data': { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
}

const planItem: PreviewToolItem = {
  id: 'tool:session-1:plan',
  projectId: 'project-1',
  sessionId: 'session-1',
  type: 'tool',
  toolKind: 'plan',
  title: 'Session Plan'
}

const createSession = (): unknown => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Plan session',
  cwd: '/workspace',
  // A turn that is streaming text (`running`): the projection rewrites the status on the first chunk of a
  // waiting session, so modelling a plan-approval wait here would measure that state change, not the text.
  status: 'running',
  activeRun: { promptMessageId: 'interaction-1', startedAt: 1 },
  activePlanProjection: pendingProjection,
  messages: [
    {
      id: 'interaction-1',
      role: 'user',
      content: 'Plan this',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'reply-1',
      role: 'agent',
      content: 'partial',
      status: 'streaming',
      streamId: 'stream-1',
      eventIds: [],
      responseToMessageId: 'interaction-1',
      createdAt: 2,
      updatedAt: 2
    }
  ],
  createdAt: 1,
  updatedAt: 2
})

const planSurfaceRenders = (): number => instrument.planSurface.mock.calls.length

beforeEach(() => {
  useSessionStore.setState({ sessions: [createSession() as never] })
  usePreviewWorkbenchStore.setState({ expandedToolItemId: null })
})

afterEach(cleanup)

describe('plan preview render cost per streamed chunk', () => {
  it('does not re-render the plan surface for a chunk of transcript text', () => {
    render(<PreviewToolContent item={planItem} />)
    expect(planSurfaceRenders()).toBe(1)

    instrument.planSurface.mockClear()
    act(() => {
      useSessionStore.getState().appendAgentMessageChunk({
        sessionId: 'session-1',
        streamId: 'stream-1',
        eventId: 'event-2',
        content: ' more'
      })
    })

    console.log(`[render-count] plan preview per chunk: ${planSurfaceRenders()}`)

    // The chunk landed (the transcript's text moved)…
    expect(useSessionStore.getState().sessions[0]?.messages[1]?.content).toBe('partial more')
    // …and the plan preview was not part of the cost of showing it.
    expect(planSurfaceRenders()).toBe(0)
  })

  it('re-renders the plan surface when the projection itself changes', () => {
    render(<PreviewToolContent item={planItem} />)
    instrument.planSurface.mockClear()

    act(() => {
      // A structural change the preview must react to: the plan moved on to a new revision.
      useSessionStore.getState().setActivePlanProjection('session-1', {
        ...pendingProjection,
        revision: 4,
        artifactVersionId: 'version-2'
      })
    })

    expect(planSurfaceRenders()).toBe(1)
  })
})
