// S3 pilot harness: one case, one arm, one recorded run — then grade it against the same atomic
// checks the suite uses.
//
// It is a vitest file because that is how this repo runs TypeScript without adding a loader, and it
// is skipped unless you ask for it: with `PILOT_CASE` unset (every CI run, every normal `npm test`)
// the whole suite is inert.
//
// Commands
// --------
//   # what would happen, no network, no app needed
//   PILOT_CASE=checkpoint-resume-order PILOT_ARM=no-contract PILOT_DRY_RUN=1 \
//     npx vitest run scripts/bench/pilot.test.ts
//
//   # the real thing, against an app already provisioned for that arm
//   PURESCIENCE_ABLATION=no-contract purescience start --no-open   # one arm at a time
//   PILOT_CASE=checkpoint-resume-order PILOT_ARM=no-contract \
//   PILOT_BASE_URL=http://127.0.0.1:<port> PILOT_TOKEN=<token> PILOT_PROJECT=<projectId> \
//     npx vitest run scripts/bench/pilot.test.ts
//
// What the arm claim means: the harness refuses to grade when `PILOT_ARM` disagrees with the
// `PURESCIENCE_ABLATION` the app was started with, because a run labelled with an arm it did not run
// under is worse than no run at all.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseAblationArm, ABLATION_ENV } from '../../src/shared/ablation'
import { SCI_BENCH_V1_CASES } from '../../src/shared/sci-bench-v1-cases'
import { evaluateBenchCase, type BenchEvidence } from '../../src/shared/sci-bench-v1'

const caseId = process.env.PILOT_CASE?.trim()
const arm = process.env.PILOT_ARM?.trim() || 'full-contract'
const dryRun = process.env.PILOT_DRY_RUN === '1'

const benchCase = caseId ? SCI_BENCH_V1_CASES.find((entry) => entry.id === caseId) : undefined

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${process.env.PILOT_TOKEN ?? ''}`,
      'content-type': 'application/json'
    }
  })
  const body = (await response.json()) as { data?: T; error?: unknown }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(body.error ?? body)}`)
  }
  return body.data as T
}

describe.skipIf(!caseId)('S3 pilot', () => {
  it('names the case it was asked for, or refuses', () => {
    expect(benchCase, `No case named ${caseId}`).toBeDefined()
    // The arm the run is *labelled* with must be the arm the app was started with.
    expect(parseAblationArm(process.env[ABLATION_ENV])).toBe(arm)
  })

  it.skipIf(dryRun)('runs the case, reads its evidence and grades it', async () => {
    const baseUrl = process.env.PILOT_BASE_URL?.replace(/\/$/, '')
    const projectId = process.env.PILOT_PROJECT?.trim()
    expect(baseUrl, 'PILOT_BASE_URL is required for a real run').toBeTruthy()
    expect(projectId, 'PILOT_PROJECT is required for a real run').toBeTruthy()

    const started = await request<{ id: string; sessionId: string }>(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      body: JSON.stringify({ projectId, prompt: benchCase!.prompt })
    })

    // Poll to completion. The budget is deliberately visible rather than infinite.
    const deadline = Date.now() + Number(process.env.PILOT_TIMEOUT_MS ?? 15 * 60 * 1000)
    let run = await request<{ status: string; error?: string }>(
      `${baseUrl}/api/v1/runs/${started.id}`
    )
    while (run.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      run = await request<{ status: string; error?: string }>(
        `${baseUrl}/api/v1/runs/${started.id}`
      )
    }
    expect(['completed', 'failed'], `run ended as ${run.status}`).toContain(run.status)

    const collected = await request<{ found: boolean; evidence: BenchEvidence | null }>(
      `${baseUrl}/api/v1/sessions/${started.sessionId}/evidence`
    )
    expect(collected.found, 'the run produced no session to grade').toBe(true)
    const result = evaluateBenchCase(benchCase!, collected.evidence ?? { transcript: '' })

    const record = {
      caseId: benchCase!.id,
      arm,
      runId: started.id,
      sessionId: started.sessionId,
      runStatus: run.status,
      runError: run.error ?? null,
      model: process.env.PILOT_MODEL ?? null,
      runtime: process.env.PILOT_RUNTIME ?? null,
      seed: process.env.PILOT_SEED ? Number(process.env.PILOT_SEED) : null,
      recordedAt: new Date().toISOString(),
      evidenceCollected: (collected.evidence as { collected?: unknown } | null)?.collected ?? null,
      result
    }
    const outDir = join(process.cwd(), 'docs', 'bench-runs')
    await mkdir(outDir, { recursive: true })
    const outFile = join(
      outDir,
      `${record.recordedAt.replace(/[:.]/g, '-')}-${benchCase!.id}-${arm}.json`
    )
    await writeFile(outFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    // Printed so the run's own log carries the verdict, not just the file.
    console.log(`pilot result: ${outFile}`)
    console.log(JSON.stringify({ passed: result.passed, atomic: result.atomicPassRate }, null, 2))
  })
})

// Always runs: the plan is worth printing (and asserting) even when nothing is executed.
describe('S3 pilot plan', () => {
  it('accepts only a supported arm', () => {
    expect(() => parseAblationArm(arm)).not.toThrow()
  })

  it('prints what it would do when asked to', () => {
    const plan = {
      case: benchCase?.id ?? '(none — set PILOT_CASE)',
      dimension: benchCase?.dimension ?? null,
      arm,
      execute: Boolean(caseId) && !dryRun,
      needs: dryRun || !caseId ? [] : ['PILOT_BASE_URL', 'PILOT_TOKEN', 'PILOT_PROJECT']
    }
    if (process.env.PILOT_PRINT_PLAN === '1' || dryRun) console.log(JSON.stringify(plan, null, 2))
    if (caseId) expect(benchCase).toBeDefined()
  })
})
