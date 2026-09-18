/* eslint-disable @typescript-eslint/explicit-function-return-type -- a reproduction probe, driven by
   hand from a CDP session against the packaged build; it is evidence, not product code. */
// The resource-entry check cannot see file:// loads, so it proved nothing. Debugger.scriptParsed fires for
// every script V8 compiles, file:// included — that is the instrument that can settle where (program) goes.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const req = createRequire('/Users/totota/purescience/package.json')
const { chromium } = req('playwright')

const report = {}
const main = async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9335')
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes('app.asar'))
  page.setDefaultTimeout(30000)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Debugger.enable')
  let parsed = []
  cdp.on('Debugger.scriptParsed', (event) => {
    parsed.push({ url: (event.url || '').split('/').pop(), length: event.length ?? 0 })
  })

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

  const windowFor = async (label, action) => {
    parsed = []
    const started = Date.now()
    await action()
    const elapsed = Date.now() - started
    report[label] = {
      elapsedMs: elapsed,
      scriptsParsed: parsed.length,
      parsedBytes: parsed.reduce((sum, entry) => sum + entry.length, 0),
      biggest: [...parsed].sort((a, b) => b.length - a.length).slice(0, 6)
    }
  }

  await page.reload({ waitUntil: 'domcontentloaded' })
  await windowFor('page load (baseline window)', async () => await page.waitForTimeout(4000))

  await windowFor('open search panel', async () => {
    await click('搜索会话和产物', 'aria-prefix')
    await page.waitForTimeout(2500)
  })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)

  await windowFor('open a session', async () => {
    await click('我想知道 EGFR 突变体 T790M')
    await page.waitForTimeout(7000)
  })

  await windowFor('open Files panel', async () => {
    await click('文件', 'contains')
    await page.waitForTimeout(3500)
  })

  await windowFor('scroll transcript', async () => {
    for (let step = 0; step < 8; step += 1) {
      await page.mouse.wheel(0, 900)
      await page.waitForTimeout(160)
    }
  })

  writeFileSync('/tmp/ps-ui-scripts.json', JSON.stringify(report, null, 1))
  await browser.close()
}

main().catch((error) => {
  report.fatal = String(error)
  writeFileSync('/tmp/ps-ui-scripts.json', JSON.stringify(report, null, 1))
})
