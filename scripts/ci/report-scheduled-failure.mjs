/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Opens, refreshes or closes the single tracking issue for the scheduled regression lane.
//
// A daily lane that only turns a badge red gets ignored: nobody is watching the Actions tab at 03:17
// UTC. Routing an unstable-or-failing scheduled run into one deduplicated issue means the signal
// survives in the place the team actually reads, and closing it when the lane goes green keeps the
// issue honest instead of leaving a stale red thread open forever.
//
// Usage (CI):
//   node scripts/ci/report-scheduled-failure.mjs \
//     --lane vitest=${{ needs.vitest_stability.result }} \
//     --lane e2e=${{ needs.e2e_stability.result }} \
//     --run-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
//
// The decision is exported (decideScheduledFailureAction) so tests can pin every branch without
// touching the GitHub API.

const DEFAULT_LABEL = 'ci-scheduled-failure'
const ISSUE_TITLE = 'Scheduled regression lane is failing'

/**
 * @param {{ lanes: Record<string, string>, openIssues: { number: number }[], runUrl?: string }} input
 * @returns {{ action: 'create' | 'comment' | 'close' | 'none', issueNumber?: number, title?: string, body?: string }}
 */
export function decideScheduledFailureAction({ lanes, openIssues, runUrl }) {
  const failing = Object.entries(lanes).filter(([, outcome]) => outcome === 'failure')
  const errored = Object.entries(lanes).filter(
    ([, outcome]) => outcome !== 'success' && outcome !== 'failure'
  )
  const broken = [...failing, ...errored]

  if (broken.length > 0) {
    const summary = broken.map(([lane, outcome]) => `- \`${lane}\`: **${outcome}**`).join('\n')
    const body = [
      `The scheduled regression lane reported ${broken.length} unhealthy job${broken.length === 1 ? '' : 's'}:`,
      '',
      summary,
      '',
      `Run: ${runUrl ?? '(run url unavailable)'}`,
      '',
      'Reproduce locally with the same strictness the lane uses:',
      '',
      '```bash',
      'npm test -- --retry=1 --reporter=default --reporter=./scripts/ci/flaky-tests-reporter.mjs',
      'node scripts/ci/check-flaky-tests.mjs flaky-tests.json',
      'npm run build:e2e && npm run test:e2e:journey -- --fail-on-flaky-tests',
      '```',
      '',
      'A test that passes only after a retry is reported here on purpose: the retry is what keeps',
      'ordinary CI green, so this lane is the only place the instability is visible.'
    ].join('\n')

    if (openIssues.length > 0) {
      return { action: 'comment', issueNumber: openIssues[0].number, body }
    }

    return { action: 'create', title: ISSUE_TITLE, body }
  }

  if (openIssues.length > 0) {
    return {
      action: 'close',
      issueNumber: openIssues[0].number,
      body: `Back to green: every scheduled lane job succeeded.\n\nRun: ${runUrl ?? '(run url unavailable)'}`
    }
  }

  return { action: 'none' }
}

/** @returns {Record<string, string>} */
export function parseLaneArguments(argv) {
  const lanes = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--lane') continue
    const value = argv[index + 1] ?? ''
    const separator = value.indexOf('=')
    if (separator <= 0) continue
    lanes[value.slice(0, separator)] = value.slice(separator + 1)
    index += 1
  }
  return lanes
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const { execFileSync } = await import('node:child_process')

  const argv = process.argv.slice(2)
  const labelIndex = argv.indexOf('--label')
  const label = labelIndex >= 0 ? (argv[labelIndex + 1] ?? DEFAULT_LABEL) : DEFAULT_LABEL
  const runUrlIndex = argv.indexOf('--run-url')
  const runUrl = runUrlIndex >= 0 ? argv[runUrlIndex + 1] : undefined
  const lanes = parseLaneArguments(argv)

  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' })
  const openIssues = JSON.parse(
    gh([
      'issue',
      'list',
      '--label',
      label,
      '--state',
      'open',
      '--json',
      'number,title',
      '--limit',
      '5'
    ])
  )

  const decision = decideScheduledFailureAction({ lanes, openIssues, runUrl })
  console.log(`[scheduled-regression] lanes=${JSON.stringify(lanes)} action=${decision.action}`)

  if (decision.action === 'create') {
    gh(['issue', 'create', '--title', decision.title, '--body', decision.body, '--label', label])
  } else if (decision.action === 'comment') {
    gh(['issue', 'comment', String(decision.issueNumber), '--body', decision.body])
  } else if (decision.action === 'close') {
    gh(['issue', 'comment', String(decision.issueNumber), '--body', decision.body])
    gh(['issue', 'close', String(decision.issueNumber)])
  }
}
