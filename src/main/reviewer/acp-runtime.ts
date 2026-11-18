import type { AcpRuntime } from '../acp/runtime'
import type {
  AcpRuntimeActivity,
  AcpRuntimeActivityOptions,
  AcpRuntimeActivityOwner
} from '../acp/runtime-activity'

// Reviewer orchestration needs only this public runtime surface. Keeping it structural lets tests use
// small stubs while production pins the whole review/fix-loop workflow to one runtime generation.
export type ReviewerAcpRuntime = Pick<
  AcpRuntime,
  'buildReviewerSession' | 'disposeReviewerSession' | 'sendPrompt'
> &
  Partial<AcpRuntimeActivityOwner> & {
    // Sessions that still hold a prompt interaction. The review starts as soon as the turn's text is
    // persisted, which can be before that turn has left the wire — injecting then answers
    // `An ACP prompt is already running for this session` and the correction is lost. Absent in tests
    // that never model this race.
    getActivePromptSessions?: () => { projectName: string; sessionId: string }[]
  }

export const withReviewerRuntimeActivity = <T>(
  runtime: ReviewerAcpRuntime,
  options: AcpRuntimeActivityOptions,
  work: (runtime: AcpRuntimeActivity) => Promise<T>
): Promise<T> => (runtime.withActivity ? runtime.withActivity(options, work) : work(runtime))
