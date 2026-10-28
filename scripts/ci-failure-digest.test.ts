import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { digestRun, pickRunIds, readJobLog, stripLogNoise } from './ci-failure-digest.mjs'

// What this suite holds the digest to: that it quotes the shapes the real logs carry (ANSI colour, the
// RFC3339 prefix, `FAIL   unit  <path>`, the vitest summary block, `##[error]` and a `Caused by:` chain),
// and that every "no answer" it can reach is a NAMED state with a non-zero exit rather than an empty
// digest — the whole point of the tool is that `gh run view --log-failed` answered 0 bytes and exit 0.

const cliPath = fileURLToPath(new URL('./ci-failure-digest.mjs', import.meta.url))

const at = (instant: string, text: string): string => `${instant} ${text}`

/** Trimmed from the red Verify job of `dae37ac3`; the ANSI code and prefix are exactly what arrives. */
const redLog: string = [
  at(
    '2026-10-27T11:02:19.0747140Z',
    '##[error]mac update feed /tmp/latest-mac.yml is not complete for both architectures:'
  ),
  at(
    '2026-10-27T11:07:49.7385530Z',
    ' FAIL   unit  src/main/ipc-handler-registry.test.ts [ src/main/ipc-handler-registry.test.ts ]'
  ),
  at(
    '2026-10-27T11:07:49.7386790Z',
    ' FAIL   unit  src/main/settings/validate.test.ts [ src/main/settings/validate.test.ts ]'
  ),
  at(
    '2026-10-27T11:07:49.7388020Z',
    ' FAIL   unit  src/main/ipc-handler-registry.test.ts [ src/main/ipc-handler-registry.test.ts ]'
  ),
  at(
    '2026-10-27T11:07:49.7896890Z',
    '\u001b[31mError: Electron failed to install correctly.\u001b[0m'
  ),
  at('2026-10-27T11:07:49.7896990Z', ' ❯ getElectronPath node_modules/electron/index.js:43:13'),
  at(
    '2026-10-27T11:07:50.1588110Z',
    'Caused by: Caused by: Error: Electron failed to install correctly.'
  ),
  at('2026-10-27T11:07:50.1589110Z', ' Test Files  2 failed | 1290 passed | 21 skipped (1313)'),
  at('2026-10-27T11:07:50.1590110Z', '      Tests  15883 passed | 206 skipped (16089)'),
  at(
    '2026-10-27T11:07:50.1591110Z',
    '   Duration  458.13s (transform 29.65s, setup 8.90s, import 189.86s)'
  ),
  at('2026-10-27T11:07:50.1608110Z', '##[error]Process completed with exit code 1.')
].join('\n')

const run = {
  id: 40492038901,
  name: 'Nightly',
  conclusion: 'failure',
  head_sha: 'dae37ac3478bb727208daeaa13390bf41c3bd83c',
  html_url: 'https://example.invalid/run'
}

const jobsOf = (
  steps: Array<{ name: string; conclusion: string }>,
  conclusion = 'failure'
): unknown => ({
  jobs: [
    {
      id: 1,
      name: 'build / Resolve platform matrix',
      conclusion: 'success',
      steps: [{ name: 'Set up job', conclusion: 'success' }]
    },
    { id: 2, name: 'build / Verify (lint + typecheck + test + package)', conclusion, steps },
    { id: 3, name: 'publish', conclusion: 'skipped', steps: [] }
  ]
})

const dirs: string[] = []

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-failure-digest-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const runDigest = (options: {
  log?: string
  steps?: Array<{ name: string; conclusion: string }>
  jobConclusion?: string
  maxFiles?: number
  readLogThrows?: string
}): { code: number; text: string; outDir: string } => {
  const outDir = tempDir()
  const steps = options.steps ?? [
    { name: 'Lint', conclusion: 'success' },
    { name: 'Test (with coverage)', conclusion: 'failure' }
  ]
  const digest = digestRun({
    repo: 'owner/repo',
    runId: String(run.id),
    outDir,
    maxFiles: options.maxFiles ?? 15,
    readJson: (path: string): unknown =>
      path.includes('/jobs') ? jobsOf(steps, options.jobConclusion) : run,
    readLog: (): string => {
      if (options.readLogThrows)
        throw Object.assign(new Error('gh failed'), { stderr: options.readLogThrows })
      return options.log ?? redLog
    }
  })
  return { code: digest.code, text: digest.lines.join('\n'), outDir }
}

describe('stripLogNoise', () => {
  it('removes the RFC3339 prefix and ANSI colour, and keeps the words', () => {
    const noisy = '2026-10-27T11:07:49.7896890Z \u001b[31mError: boom\u001b[0m'
    expect(stripLogNoise(noisy)).toBe('Error: boom')
  })

  it('strips the prefix on every line, not just the first', () => {
    const noisy = ['2026-10-27T11:07:49.1Z one', '2026-10-27T11:07:49.2Z two'].join('\n')
    expect(stripLogNoise(noisy)).toBe('one\ntwo')
  })
})

describe('readJobLog', () => {
  const findings = readJobLog(redLog)

  it('lists each failing test file once, in first-seen order', () => {
    expect(findings.failedFiles).toEqual([
      'src/main/ipc-handler-registry.test.ts',
      'src/main/settings/validate.test.ts'
    ])
  })

  it('keeps the three vitest summary numbers verbatim', () => {
    expect(findings.summaries['Test Files']).toBe('2 failed | 1290 passed | 21 skipped (1313)')
    expect(findings.summaries.Tests).toBe('15883 passed | 206 skipped (16089)')
    expect(findings.summaries.Duration).toContain('458.13s')
  })

  it('carries the cause with the frame printed under it, and collapses the `Caused by:` repeat into it', () => {
    expect(findings.causes).toHaveLength(1)
    expect(findings.causes[0]).toBe(
      'Error: Electron failed to install correctly. · at getElectronPath node_modules/electron/index.js:43:13'
    )
  })

  it("does not read eslint's warning tally as a cause", () => {
    const lintLine = at('2026-10-27T11:07:49.1Z', '✖ 119 problems (0 errors, 119 warnings)')
    expect(readJobLog(lintLine).causes).toEqual([])
  })

  it('keeps every ##[error] line rather than only the last', () => {
    expect(findings.errorMarkers).toHaveLength(2)
  })

  it('reads the shapes a green log carries as "no failure here" rather than inventing one', () => {
    const clean = at('2026-10-27T19:14:55.8647840Z', ' Test Files  1401 passed | 24 skipped (1425)')
    expect(readJobLog(clean)).toMatchObject({ failedFiles: [], causes: [], errorMarkers: [] })
  })
})

describe('digestRun', () => {
  it('names the failing step, quotes the summary and the cause, and keeps the full log on disk', () => {
    const { code, text, outDir } = runDigest({})
    expect(code).toBe(0)
    expect(text).toContain('run 40492038901 (Nightly, failure) · head dae37ac3')
    expect(text).toContain('failing step(s): Test (with coverage)')
    expect(text).toContain('vitest: Test Files 2 failed | 1290 passed | 21 skipped (1313)')
    expect(text).toContain('src/main/settings/validate.test.ts')
    expect(text).toContain('root cause candidates (1 distinct, first 1):')
    expect(text).toContain('Electron failed to install correctly. · at getElectronPath')
    expect(text).toContain('##[error] lines: 2 (last: Process completed with exit code 1.)')
    expect(readFileSync(join(outDir, 'job-2.log'), 'utf8')).toBe(redLog)
  })

  it('caps the printed file list but says how many it hid and how to see them', () => {
    const { text } = runDigest({ maxFiles: 1 })
    expect(text).toContain("… and 1 more (grep ' FAIL '")
    expect(text).not.toContain('src/main/settings/validate.test.ts')
  })

  it('reports no-failed-jobs on its own line and exits 2 when every job passed', () => {
    const { code, text } = runDigest({ jobConclusion: 'success' })
    expect(code).toBe(2)
    expect(text).toContain('no-failed-jobs: 3 job(s), none failed')
    expect(text).toContain('build / Verify (lint + typecheck + test + package)=success')
  })

  it('names an empty log instead of reading it as "no failure" (exit 3)', () => {
    const { code, text } = runDigest({ log: '' })
    expect(code).toBe(3)
    expect(text).toContain('logs-unavailable')
    expect(text).not.toContain('no-failure-markers')
  })

  it('quotes why the log could not be fetched', () => {
    const { code, text } = runDigest({ readLogThrows: 'HTTP 404: Not Found' })
    expect(code).toBe(3)
    expect(text).toContain('logs-unavailable: the API returned an empty log (HTTP 404: Not Found)')
  })

  it('exits 4 with no-failure-markers when the log has no marker at all', () => {
    const { code, text } = runDigest({ log: at('2026-10-27T11:07:49.1Z', 'nothing to see') })
    expect(code).toBe(4)
    expect(text).toContain('no-failure-markers: 1 failed job(s) read')
  })
})

describe('pickRunIds', () => {
  it('keeps only the failed runs when any failed', () => {
    expect(
      pickRunIds([
        { id: 1, conclusion: 'success' },
        { id: 2, conclusion: 'failure' }
      ])
    ).toEqual(['2'])
  })

  it('returns every run when none failed, so the caller still has something to print', () => {
    expect(
      pickRunIds([
        { id: 1, conclusion: 'success' },
        { id: 3, conclusion: 'cancelled' }
      ])
    ).toEqual(['1', '3'])
  })
})

describe('cli', () => {
  const runCli = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: '' }
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it('prints usage and exits 0 on --help (no network)', () => {
    const { status, stdout } = runCli(['--help'])
    expect(status).toBe(0)
    expect(stdout).toContain('usage: node scripts/ci-failure-digest.mjs')
    expect(stdout).toContain('Exit codes: 0 digest produced')
  })

  it('refuses an unknown option with exit 1 instead of doing something surprising', () => {
    const { status, stderr } = runCli(['--nope'])
    expect(status).toBe(1)
    expect(stderr).toContain('unknown option --nope')
  })
})
