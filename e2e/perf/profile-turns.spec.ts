import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { createProject } from '../certification/helpers'
import { test as appTest } from '../fixtures/electron-app'

// WHERE A STREAMED TURN SPENDS ITS SCRIPT TIME — a profiling tool, not a gate.
//
// The smoothness baseline says a streamed turn costs ~64 ms of main-thread time. That number says how much,
// not where: a long-task probe cannot see it (no single task crosses 50 ms) and the mutation-batch ratio
// only rules out "re-render per delta". This walks the same scenario under CDP's sampling profiler and
// prints self time per function, so the fix is chosen from readings instead of from a guess.
//
//   npm run build:e2e && PERF_TURNS=10 npx playwright test e2e/perf/profile-turns.spec.ts --reporter=line
//
// Self time, not inclusive: a wrapper that calls a hot function would otherwise look hot too, and the
// question here is which function's own body burns the milliseconds.

const sendTurn = async (page: Page, prompt: string): Promise<void> => {
  const replies = page.getByText('Deterministic reply', { exact: false })
  const before = await replies.count()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect.poll(async () => replies.count(), { timeout: 60_000 }).toBeGreaterThan(before)
}

interface CallFrame {
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
}

interface ProfileNode {
  id: number
  callFrame: CallFrame
}

interface SamplingProfile {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
}

const shortUrl = (url: string): string => {
  if (!url) return '(native)'
  const marker = url.indexOf('/out/renderer/')
  return marker === -1
    ? url.split('/').slice(-2).join('/')
    : url.slice(marker + '/out/renderer/'.length)
}

const topSelfTime = (
  profile: SamplingProfile,
  limit: number
): { label: string; ms: number; samples: number }[] => {
  const byNode = new Map<number, number>()
  let totalMicros = 0
  for (let index = 0; index < profile.samples.length; index += 1) {
    const nodeId = profile.samples[index]
    const micros = profile.timeDeltas[index] ?? 0
    totalMicros += micros
    byNode.set(nodeId, (byNode.get(nodeId) ?? 0) + micros)
  }
  const frames = new Map<string, { ms: number; samples: number }>()
  for (const [nodeId, micros] of byNode) {
    const node = profile.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) continue
    const { functionName, url, lineNumber } = node.callFrame
    const label = `${functionName || '(anonymous)'} @ ${shortUrl(url)}:${lineNumber + 1}`
    const entry = frames.get(label) ?? { ms: 0, samples: 0 }
    entry.ms += micros / 1000
    entry.samples += 1
    frames.set(label, entry)
  }
  console.log(
    `[profile] sampled ${Math.round(totalMicros / 1000)}ms across ${profile.samples.length} samples`
  )
  return [...frames.entries()]
    .map(([label, entry]) => ({ label, ...entry }))
    .sort((left, right) => right.ms - left.ms)
    .slice(0, limit)
}

appTest(
  'profiles where a streamed turn spends its script time',
  // The budget is set from inside the test: Playwright's `TestDetails` carries tag/annotation only, so a
  // third argument with `timeout` fails the type check while the runtime keeps the default 30 s — a 40-turn
  // profile would then be cut off mid-run, with the last sample looking like the end of the stream.
  async ({ app }) => {
    appTest.setTimeout(240_000)
    let page = await app.completeOnboarding()
    page = await app.configureFakeAgent()
    await createProject(page, 'Turn profile')
    await page.bringToFront()

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })

    const turns = Number(process.env.PERF_TURNS ?? 10)
    // One warm-up turn outside the profile: the first turn of a session also pays for the empty-state
    // teardown, and counting that as "per turn" would point the fix at the wrong code.
    await sendTurn(page, 'Warm-up turn')

    await cdp.send('Profiler.start')
    for (let index = 0; index < turns; index += 1) {
      await sendTurn(page, `Profile turn ${index}`)
    }
    const { profile } = (await cdp.send('Profiler.stop')) as { profile: SamplingProfile }

    const ranked = topSelfTime(profile, 20)
    for (const entry of ranked) {
      console.log(`[profile] ${entry.ms.toFixed(1).padStart(8)}ms  ${entry.label}`)
    }
    expect(ranked.length).toBeGreaterThan(0)
  }
)
