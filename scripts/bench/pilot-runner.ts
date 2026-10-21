// The pilot's real-run half, extracted so it can be tested against a fake server instead of only
// against a live app: start a run, poll it, read the session's evidence, grade it, write one record.
//
// The record is the deliverable. Every field in it is something a later reader needs to judge the
// number: which case, which arm, which run and session, whether the run completed or failed, and what
// evidence the grader actually saw (including what it could not collect).

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  evaluateBenchCase,
  type BenchCaseV1,
  type BenchEvidence,
  type CaseResult
} from '../../src/shared/sci-bench-v1'

export type PilotOptions = {
  baseUrl: string
  token: string
  /** The app's project field is `project` (an id or a name); the wire shape is not the local naming. */
  project: string
  /**
   * Grade an existing session instead of starting a new run. Re-grading after fixing a check must not
   * cost another model call, and must not be reported as a fresh run.
   */
  sessionId?: string | null
  benchCase: BenchCaseV1
  arm: string
  outDir: string
  model?: string | null
  runtime?: string | null
  seed?: number | null
  /** Headless runs have no window to answer a permission card in; the pilot must say so up front. */
  permissionProfile?: 'ask' | 'auto' | 'full'
  /** Wall-clock budget for the run itself. Exceeding it is a recorded failure, not a hang. */
  timeoutMs?: number
  pollMs?: number
  now?: () => Date
}

export type PilotRecord = {
  caseId: string
  arm: string
  runId: string
  sessionId: string
  runStatus: string
  runError: string | null
  model: string | null
  runtime: string | null
  seed: number | null
  recordedAt: string
  evidenceCollected: unknown
  result: CaseResult
}

const call = async <T>(url: string, token: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    }
  })
  const body = (await response.json()) as { data?: T; error?: unknown }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(body.error ?? body)}`)
  }
  return body.data as T
}

export const runPilot = async (
  options: PilotOptions
): Promise<{ record: PilotRecord; file: string }> => {
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const pollMs = options.pollMs ?? 5_000
  const deadline = (options.now?.() ?? new Date()).getTime() + (options.timeoutMs ?? 15 * 60 * 1000)

  const reused = options.sessionId?.trim()
  const started = reused
    ? { id: '(regraded)', sessionId: reused }
    : await call<{ id: string; sessionId: string }>(`${baseUrl}/api/v1/runs`, options.token, {
        method: 'POST',
        body: JSON.stringify({
          project: options.project,
          prompt: options.benchCase.prompt,
          ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {})
        })
      })

  let run: { status: string; error?: string } = reused
    ? { status: 'regraded' }
    : await call<{ status: string; error?: string }>(
        `${baseUrl}/api/v1/runs/${started.id}`,
        options.token
      )
  while (run.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    run = await call<{ status: string; error?: string }>(
      `${baseUrl}/api/v1/runs/${started.id}`,
      options.token
    )
  }

  const collected = await call<{ found: boolean; evidence: BenchEvidence | null }>(
    `${baseUrl}/api/v1/sessions/${started.sessionId}/evidence`,
    options.token
  )
  // A run that produced no session cannot be graded; saying so is the honest outcome, and the record
  // keeps it distinguishable from "graded and failed".
  const evidence: BenchEvidence = collected.evidence ?? { transcript: '' }
  const result = evaluateBenchCase(options.benchCase, evidence)

  const record: PilotRecord = {
    caseId: options.benchCase.id,
    arm: options.arm,
    runId: started.id,
    sessionId: started.sessionId,
    runStatus: run.status,
    runError: run.error ?? null,
    model: options.model ?? null,
    runtime: options.runtime ?? null,
    seed: options.seed ?? null,
    recordedAt: (options.now?.() ?? new Date()).toISOString(),
    evidenceCollected: (evidence as { collected?: unknown }).collected ?? null,
    result
  }

  await mkdir(options.outDir, { recursive: true })
  const stamp = record.recordedAt.replace(/[:.]/g, '-')
  const file = join(options.outDir, `${stamp}-${record.caseId}-${record.arm}.json`)
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return { record, file }
}
