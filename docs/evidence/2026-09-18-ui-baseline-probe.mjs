/* eslint-disable @typescript-eslint/explicit-function-return-type -- a reproduction probe, driven by
   hand from a CDP session against the packaged build; it is evidence, not product code. */
// Unit ①: packaged-build UI smoothness baseline.
// Every UI number this project had before came from a dev build and was later judged unusable (jsxDEV
// inflated it), so this samples the packaged bundle: rAF frame intervals + long tasks, per interaction.
//
// Conventions kept from the earlier probes: pre-checks before believing anything, finders passed as data,
// and results written to a file (the shell is not a channel I rely on for numbers).
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const req = createRequire('/Users/totota/purescience/package.json')
const { chromium } = req('playwright')

const report = { checks: {}, samples: [], notes: [] }

const startProbe = () => {
  window.__uiProbe = { active: true, frames: [], longtasks: [], last: performance.now() }
  const probe = window.__uiProbe
  const loop = () => {
    if (!probe.active) return
    const now = performance.now()
    probe.frames.push(now - probe.last)
    probe.last = now
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  try {
    probe.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        probe.longtasks.push({
          start: Math.round(entry.startTime),
          duration: Math.round(entry.duration)
        })
      }
    })
    probe.observer.observe({ entryTypes: ['longtask'] })
  } catch (error) {
    probe.observerError = String(error)
  }
}

const stopProbe = () => {
  const probe = window.__uiProbe
  probe.active = false
  probe.observer?.disconnect()
  const frames = probe.frames.slice(1)
  const sorted = [...frames].sort((a, b) => a - b)
  const longtasks = probe.longtasks
  const result = {
    frames: frames.length,
    frameMedianMs: sorted.length
      ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10
      : null,
    frameP95Ms: sorted.length
      ? Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10
      : null,
    frameWorstMs: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null,
    framesOver50ms: frames.filter((value) => value > 50).length,
    longTasks: longtasks.length,
    longTaskMaxMs: longtasks.length ? Math.max(...longtasks.map((task) => task.duration)) : 0,
    longTaskTotalMs: longtasks.reduce((sum, task) => sum + task.duration, 0),
    observerError: probe.observerError ?? null
  }
  delete window.__uiProbe
  return result
}

const main = async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9335')
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes('app.asar'))
  if (!page) {
    report.checks = { page: 'not-found' }
    writeFileSync('/tmp/ps-ui-baseline.json', JSON.stringify(report, null, 1))
    await browser.close()
    return
  }
  page.setDefaultTimeout(30000)

  // PRE-CHECKS: packaged bundle + a mounted DOM, before any number is believed.
  const mounted = await page.evaluate(() => ({
    buttons: document.querySelectorAll('button, [role="button"], a').length,
    textLen: (document.body.innerText || '').length
  }))
  report.checks = {
    url: page.url(),
    isPackagedBundle: page.url().includes('app.asar'),
    buttons: mounted.buttons,
    textLen: mounted.textLen,
    mountedOk: mounted.buttons > 0 && mounted.textLen > 0
  }
  if (!report.checks.mountedOk) {
    writeFileSync('/tmp/ps-ui-baseline.json', JSON.stringify(report, null, 1))
    await browser.close()
    return
  }

  const findBox = (spec) =>
    page.evaluate((query) => {
      const pattern = query.pattern ? new RegExp(query.pattern, 'i') : null
      const matches = (element) => {
        const text = (element.innerText || '').replace(/\s+/g, ' ').trim()
        const aria = element.getAttribute('aria-label') || ''
        if (query.mode === 'aria-prefix') return aria.startsWith(query.needle)
        if (query.mode === 'text') return text === query.needle
        if (query.mode === 'contains')
          return text.includes(query.needle) || aria.includes(query.needle)
        if (query.mode === 'pattern') return pattern.test(text)
        return false
      }
      const element = Array.from(document.querySelectorAll(query.selector)).find(matches)
      if (!element) return { missing: true }
      const rect = element.getBoundingClientRect()
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        text: (element.innerText || element.getAttribute('aria-label') || '').slice(0, 40)
      }
    }, spec)

  const click = async (spec) => {
    const box = await findBox(spec)
    if (!box || box.missing) return false
    await page.mouse.click(box.x, box.y)
    return true
  }

  const measure = async (label, action) => {
    await page.evaluate(startProbe)
    const started = Date.now()
    await action()
    const elapsed = Date.now() - started
    const sample = await page.evaluate(stopProbe)
    report.samples.push({ label, elapsedMs: elapsed, ...sample })
  }

  // 1. idle
  await measure('idle (5s)', async () => await page.waitForTimeout(5000))

  // 2. the interaction the earlier dev run flagged hardest: opening the global search panel
  await measure('open search panel', async () => {
    await click({ selector: 'button', mode: 'aria-prefix', needle: '搜索会话和产物' })
    await page.waitForTimeout(2500)
  })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)

  // 3. the new two-tier path: opening a session reads its document
  await measure('open a session (document read + transcript)', async () => {
    await click({ selector: 'button', mode: 'contains', needle: '我想知道 EGFR 突变体 T790M' })
    await page.waitForTimeout(6000)
  })

  // 4. scrolling the transcript, which is the heavy view
  await measure('scroll transcript', async () => {
    for (let step = 0; step < 8; step += 1) {
      await page.mouse.wheel(0, 900)
      await page.waitForTimeout(160)
    }
  })

  // 5. the Files panel
  await measure('open Files panel', async () => {
    await click({ selector: 'button', mode: 'text', needle: '文件' })
    await page.waitForTimeout(3000)
  })

  writeFileSync('/tmp/ps-ui-baseline.json', JSON.stringify(report, null, 1))
  await browser.close()
}

main().catch((error) => {
  report.notes.push('PROBE_ERROR ' + String(error))
  writeFileSync('/tmp/ps-ui-baseline.json', JSON.stringify(report, null, 1))
})
