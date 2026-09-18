/* eslint-disable @typescript-eslint/explicit-function-return-type -- a reproduction probe, driven by
   hand from a CDP session against the packaged build; it is evidence, not product code. */
// Unit ① phase 2 (v2): attribute the hitch, not the wait.
// v1 wrapped my fixed waits in the profile and came back as 7000 ms of (idle) out of 7143 — the signal was
// buried. This version profiles tightly around each interaction, stops the moment the DOM settles, and
// reports idle separately, because "main thread busy" vs "waiting for IPC/data" is the decision it feeds.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const req = createRequire('/Users/totota/purescience/package.json')
const { chromium } = req('playwright')

const aggregate = (profile) => {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const selfTime = new Map()
  profile.samples.forEach((id, index) => {
    const node = byId.get(id)
    const delta = profile.timeDeltas[index] ?? 0
    if (!node) return
    const frame = node.callFrame ?? {}
    const key = `${frame.functionName || '(anonymous)'} @ ${frame.url || '(native)'}`
    selfTime.set(key, (selfTime.get(key) ?? 0) + delta)
  })
  const rows = [...selfTime.entries()]
    .map(([key, micros]) => ({ key, ms: Math.round(micros / 1000) }))
    .sort((left, right) => right.ms - left.ms)
  const totalMs = Math.round(profile.timeDeltas.reduce((sum, value) => sum + value, 0) / 1000)
  const idleMs = rows
    .filter((row) => row.key.startsWith('(idle)'))
    .reduce((sum, row) => sum + row.ms, 0)
  const appMs = rows
    .filter((row) => /app\.asar/.test(row.key))
    .reduce((sum, row) => sum + row.ms, 0)
  const modulesMs = rows
    .filter((row) => /node_modules/.test(row.key))
    .reduce((sum, row) => sum + row.ms, 0)
  return {
    sampledMs: totalMs,
    idleMs,
    busyMs: totalMs - idleMs,
    appBundleMs: appMs,
    nodeModulesMs: modulesMs,
    nativeOrOtherMs: totalMs - idleMs - appMs - modulesMs,
    topBusy: rows.filter((row) => !row.key.startsWith('(idle)')).slice(0, 12)
  }
}

const report = {}
const main = async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9335')
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes('app.asar'))
  if (!page) throw new Error('packaged page not found')
  page.setDefaultTimeout(30000)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })

  const click = async (needle, mode) => {
    const box = await page.evaluate(
      (query) => {
        const matches = (element) => {
          const text = (element.innerText || '').replace(/\s+/g, ' ').trim()
          const aria = element.getAttribute('aria-label') || ''
          return query.mode === 'aria-prefix'
            ? aria.startsWith(query.needle)
            : text.includes(query.needle) || aria.includes(query.needle)
        }
        const element = Array.from(document.querySelectorAll('button, [role="button"]')).find(
          matches
        )
        if (!element) return { missing: true }
        const rect = element.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      },
      { needle, mode }
    )
    if (!box || box.missing) return false
    await page.mouse.click(box.x, box.y)
    return true
  }

  // wait for a DOM condition, so the profile stops when the UI has settled rather than after a fixed wait
  const settle = async (predicate, capMs = 6000) => {
    try {
      await page.waitForFunction(predicate, undefined, { timeout: capMs })
    } catch {
      // cap reached: the interaction is the thing we are measuring, so a timeout still yields a number
    }
  }

  const profile = async (label, action) => {
    await cdp.send('Profiler.start')
    const started = Date.now()
    await action()
    const elapsed = Date.now() - started
    const { profile: raw } = await cdp.send('Profiler.stop')
    report[label] = { elapsedMs: elapsed, ...aggregate(raw) }
  }

  await page.reload({ waitUntil: 'domcontentloaded' })
  await settle(() => document.querySelectorAll('button').length > 10, 20000)
  await page.waitForTimeout(2500)

  await profile('open search panel', async () => {
    await click('搜索会话和产物', 'aria-prefix')
    await settle(() => document.querySelectorAll('[role="dialog"], input').length > 0, 4000)
    await page.waitForTimeout(400)
  })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)

  await profile('open a session', async () => {
    await click('我想知道 EGFR 突变体 T790M')
    await settle(() => (document.body.innerText || '').includes('EGFR 突变体'), 8000)
    await page.waitForTimeout(600)
  })

  await profile('open Files panel', async () => {
    await click('文件', 'contains')
    await settle(() => /个文件|文件|Artifacts|uploads/i.test(document.body.innerText || ''), 5000)
    await page.waitForTimeout(800)
  })

  writeFileSync('/tmp/ps-ui-profile2.json', JSON.stringify(report, null, 1))
  await browser.close()
}

main().catch((error) => {
  report.fatal = String(error)
  writeFileSync('/tmp/ps-ui-profile2.json', JSON.stringify(report, null, 1))
})
