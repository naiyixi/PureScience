import type {
  NotebookEnvironmentManifest,
  NotebookFileCapture,
  NotebookRunReadEvidence,
  NotebookOutput,
  NotebookRunEnvironmentCapture,
  NotebookRunRecord,
  NotebookRunStatus,
  NotebookWorkingFile
} from '../../shared/notebook'
import {
  buildFileEvidence,
  uncapturedReadEvidence,
  unavailableWriteEvidence
} from '../../shared/notebook'
import type { NotebookRunRepository } from './repository'
import { evaluateNotebookRunRisk } from './run-risk-rules'
import { notebookRunRiskReceipt } from './run-risk-receipt'

type NotebookRunIdentity = Readonly<{
  runId: string
  sequence: number
}>

type NotebookRunTerminalizationSession = Readonly<{
  projectName: string
  sessionId: string
}>

type NotebookRunTerminalResult = {
  status: NotebookRunStatus
  stdout: string
  stderr: string
  traceback: string
  cwdAfter?: string
  outputs: NotebookOutput[]
  workingFiles?: NotebookWorkingFile[]
  fileCapture?: NotebookFileCapture
  fileReads?: NotebookRunReadEvidence
  environmentManifest?: NotebookEnvironmentManifest
  environmentManifestChecksum?: string
  environmentManifestFingerprint?: string
  environmentCapture?: NotebookRunEnvironmentCapture
  // Set only when the run was cut off rather than finished: the record then says 'interrupted' with this
  // reason, which is the difference between "your code failed" and "the app went away mid-run".
  interruptionReason?: 'app-terminated'
}

type TerminalizeNotebookRunRequest<Result extends NotebookRunTerminalResult> = {
  session: NotebookRunTerminalizationSession
  runningRun: NotebookRunRecord
  invoke: () => Promise<Result>
  postCommit?: (result: Result, run: NotebookRunRecord) => void
}

type NotebookRunTerminalizationOwnerOptions = {
  repository: Pick<NotebookRunRepository, 'appendRun' | 'updateRun'>
  notifyChanged: (session: NotebookRunTerminalizationSession) => void
  now?: () => number
}

const outputPlainText = (stdout: string, stderr: string): string[] =>
  [stdout, stderr].filter((text) => text.trim().length > 0)

class NotebookRunTerminalizationOwner {
  private sequence = 0
  private readonly now: () => number

  constructor(private readonly options: NotebookRunTerminalizationOwnerOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  allocateRunIdentity(): NotebookRunIdentity {
    this.sequence += 1
    return {
      runId: `notebook-run-${this.now()}-${this.sequence}`,
      sequence: this.sequence
    }
  }

  async run<Result extends NotebookRunTerminalResult>(
    request: TerminalizeNotebookRunRequest<Result>
  ): Promise<{ run: NotebookRunRecord; result: Result }> {
    const { session, runningRun } = request
    // v2.1.0: the record carries what the per-run risk review found, computed HERE — the one place that
    // writes a run record — from the script that is about to execute. Attached to the record that already
    // exists before execution, so the review travels with the run it reviewed; a run without a receipt is
    // read as "not assessed", never as "no risk found" (see the shared contract's field comment).
    const reviewedRun: NotebookRunRecord = {
      ...runningRun,
      riskReview: notebookRunRiskReceipt(evaluateNotebookRunRisk(runningRun.script))
    }
    await this.options.repository.appendRun({
      projectName: session.projectName,
      sessionId: session.sessionId,
      run: reviewedRun
    })
    this.options.notifyChanged(session)

    const result = await request.invoke()
    const environmentCapture: NotebookRunEnvironmentCapture =
      result.environmentCapture ??
      (runningRun.kernelKind === 'python' || runningRun.kernelKind === 'r'
        ? { state: 'unavailable', reason: 'environment-capture-failed' }
        : { state: 'unavailable', reason: 'environment-not-supported' })
    // Built from the reviewed record, not the raw one: the terminal write REPLACES the appended record,
    // so spreading `runningRun` here would drop the receipt the appended record had just been given.
    const terminalRun: NotebookRunRecord = {
      ...reviewedRun,
      status: result.status,
      endedAt: this.now(),
      cwdAfter: result.cwdAfter,
      text: {
        stdout: result.stdout,
        stderr: result.stderr,
        traceback: result.traceback,
        plain: outputPlainText(result.stdout, result.stderr)
      },
      // The normalized outputs already include any traceback; appending another error output would
      // make the preview render it twice.
      outputs: result.outputs,
      workingFiles: result.workingFiles ?? [],
      // The write axis comes from the observation that ran alongside this execution; the read axis is
      // still uncaptured on this platform path, and it says so instead of reporting an empty list.
      fileEvidence: buildFileEvidence(
        // The read axis comes from the loop that ran this cell when it reports reads at all; when it
        // does not, the record says which driver could not rather than showing an empty list.
        result.fileReads ?? uncapturedReadEvidence('driver-without-read-capture'),
        result.fileCapture ?? unavailableWriteEvidence('observation-unavailable')
      ),
      environmentCapture,
      // Only a run that was cut off carries a reason. Guarded on the status so a terminal result can never
      // stamp 'app-terminated' onto a completed or failed run.
      ...(result.status === 'interrupted' && result.interruptionReason
        ? { interruptionReason: result.interruptionReason }
        : {}),
      ...(environmentCapture.state !== 'unavailable' && result.environmentManifest
        ? { environmentManifest: result.environmentManifest }
        : {}),
      ...(environmentCapture.state !== 'unavailable' && result.environmentManifestChecksum
        ? { environmentManifestChecksum: result.environmentManifestChecksum }
        : {}),
      ...(environmentCapture.state !== 'unavailable' && result.environmentManifestFingerprint
        ? { environmentManifestFingerprint: result.environmentManifestFingerprint }
        : {})
    }
    const document = await this.options.repository.updateRun({
      projectName: session.projectName,
      sessionId: session.sessionId,
      run: terminalRun
    })
    const run = document.runs.find((candidate) => candidate.runId === runningRun.runId)

    if (!run) {
      throw new Error(`Notebook run not found after update: ${runningRun.runId}`)
    }

    request.postCommit?.(result, run)
    this.options.notifyChanged(session)

    return { run, result }
  }
}

export { NotebookRunTerminalizationOwner }
