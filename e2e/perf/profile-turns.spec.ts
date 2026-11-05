import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

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

// Same switch as the smoothness baseline: PERF_WAIT=selector keeps the harness's own text-locator polling
// out of the profile.
const sendTurn = async (page: Page, prompt: string): Promise<void> => {
  const structuralWait = process.env.PERF_WAIT === 'selector'
  if (structuralWait) {
    const bodies = (): Promise<number> =>
      page.evaluate(() => document.querySelectorAll('[data-slot="assistant-message-body"]').length)
    const before = await bodies()
    await composerInput(page).fill(prompt)
    await composerSend(page).click()
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('[data-slot="assistant-message-body"]').length > expected,
      before,
      { timeout: 60_000, polling: 200 }
    )
    return
  }
  const replies = page.getByText('Deterministic reply', { exact: false })
  const before = await replies.count()
  await composerInput(page).fill(prompt)
  await composerSend(page).click()
  await expect.poll(async () => replies.count(), { timeout: 60_000 }).toBeGreaterThan(before)
}

// CSS hooks, not role/name lookups: resolving an accessible name walks the whole document, and in a
// long transcript that walk is bigger than the work being measured. The role-based locators remain the
// real-user path and are exercised by the functional e2e suite.
interface CallFrame {
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
}

interface ProfileNode {
  id: number
  callFrame: CallFrame
  // Set by CDP; the root node has none. Used to attribute a hot function to whoever called it — a self-time
  // ranking says what burned the milliseconds, the caller chain says which of our code paths asked for it.
  parent?: number
}

interface SamplingProfile {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
}

// CSS hooks, not role/name lookups: resolving an accessible name walks the whole document, and in a long
// transcript that walk costs more than the work being measured. The role-based locators stay the real-user
// path and are exercised by the functional e2e suite.
const composerInput = (page: Page): Locator => page.locator('[data-perf="composer-input"]')
const composerSend = (page: Page): Locator => page.locator('[data-perf="composer-send"]').first()

const shortUrl = (url: string): string => {
  if (!url) return '(native)'
  const marker = url.indexOf('/out/renderer/')
  return marker === -1
    ? url.split('/').slice(-2).join('/')
    : url.slice(marker + '/out/renderer/'.length)
}

const labelOf = (node: ProfileNode): string => {
  const { functionName, url, lineNumber } = node.callFrame
  return `${functionName || '(anonymous)'}@${shortUrl(url)}:${lineNumber + 1}`
}

// Walks up from a hot node to name the code path that produced it.
const callerChain = (
  profile: SamplingProfile,
  nodeId: number,
  byId: Map<number, ProfileNode>,
  depth: number
): string => {
  const chain: string[] = []
  let current = byId.get(nodeId)?.parent
  while (current !== undefined && chain.length < depth) {
    const node = byId.get(current)
    if (!node) break
    const label = labelOf(node)
    // Collapse the profiler's own trampolines so the chain shows application frames.
    if (!/^\(anonymous\)@\(native\)/.test(label) && !/(program|idle)/.test(label)) chain.push(label)
    current = node.parent
  }
  return chain.reverse().join(' ← ') || '(root)'
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

    // Attribution: for the hottest nodes, name the application frames that led there.
    const byId = new Map(profile.nodes.map((node) => [node.id, node]))
    const hotNodes = [
      ...profile.samples.reduce((totals, nodeId, index) => {
        totals.set(nodeId, (totals.get(nodeId) ?? 0) + (profile.timeDeltas[index] ?? 0))
        return totals
      }, new Map<number, number>())
    ]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
    for (const [nodeId] of hotNodes) {
      const node = byId.get(nodeId)
      if (!node) continue
      console.log(`[callers] ${labelOf(node)}  ←  ${callerChain(profile, nodeId, byId, 6)}`)
    }
    expect(ranked.length).toBeGreaterThan(0)
  }
)
