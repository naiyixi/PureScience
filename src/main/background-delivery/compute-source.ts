// Joins finished compute jobs to the background-delivery ledger.
//
// The compute side knows a job finished; the ledger knows how a result reaches its session. Neither
// should have to learn the other's shape, so the join lives here as a function of an owner plus plain
// job fields — which is also what makes it testable without a database.
import type { BackgroundDeliveryOwner, BackgroundDeliveryRun } from './owner'

export type ComputeResultJob = {
  job_id: string
  project_id: string
  session_id: string
}

export type ComputeResultDeliveryDeps = {
  owner: Pick<BackgroundDeliveryOwner, 'registerJobResult' | 'deliverSession'>
  // Failures are reported, never swallowed: the caller decides whether to log them or let them surface.
  onError?: (error: unknown, context: { jobId?: string; sessionId?: string }) => void
}

const registerJob = async (
  job: ComputeResultJob,
  deps: ComputeResultDeliveryDeps
): Promise<void> => {
  await deps.owner.registerJobResult({
    jobId: job.job_id,
    projectId: job.project_id,
    sessionId: job.session_id
  })
}

// One finished job: register it, then drain its session. Draining is what turns "the ledger knows"
// into "the session has the result" — with no window open this is the only path that writes it.
export const deliverComputeResult = async (
  job: ComputeResultJob,
  deps: ComputeResultDeliveryDeps
): Promise<BackgroundDeliveryRun | undefined> => {
  await registerJob(job, deps)
  return deps.owner.deliverSession(job.session_id)
}

export type ComputeResultRecovery = {
  registered: number
  sessions: number
  failed: number
}

// Startup recovery: jobs already in the inbox are registered again (idempotent by job id) and their
// sessions drained, so an app restart — or a ledger write that failed while the job was finishing —
// cannot leave a finished result sitting unread in the inbox.
//
// Every job is registered BEFORE any drain: the drain claims whatever is claimable, and delivering a
// batch one job at a time would start one turn per job instead of one turn for the batch.
export const recoverComputeResults = async (
  jobs: readonly ComputeResultJob[],
  deps: ComputeResultDeliveryDeps
): Promise<ComputeResultRecovery> => {
  const sessions = new Set<string>()
  let registered = 0
  let failed = 0

  for (const job of jobs) {
    try {
      await registerJob(job, deps)
      sessions.add(job.session_id)
      registered += 1
    } catch (error) {
      failed += 1
      deps.onError?.(error, { jobId: job.job_id, sessionId: job.session_id })
    }
  }

  for (const sessionId of sessions) {
    try {
      await deps.owner.deliverSession(sessionId)
    } catch (error) {
      failed += 1
      deps.onError?.(error, { sessionId })
    }
  }

  return { registered, sessions: sessions.size, failed }
}
