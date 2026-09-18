/* eslint-disable @typescript-eslint/explicit-function-return-type -- a reproduction probe, driven by
   hand from a CDP session; it is evidence, not product code, and its shapes are deliberately loose. */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
const req = createRequire('/Users/totota/purescience/package.json')
const { chromium } = req('playwright')

const CORPUS = '/tmp/ps-bench-cold/sessions'
// Project "新的" has three sessions and three rows on Home, so one can be opened (read in full) while
// another stays a summary in the store — which is the state the guard is about.
const PROJECT = 'cmtyf335n0002wfoqwwuw25j3'
const A_MATCH = '我想知道 EGFR 突变体 T790M'
const B_MATCH = '请为我获取人类新型假想蛋白序列'
const B_ID = '0e28289b-447d-44fc-af8c-8e88075c782e'

const fileState = (sessionId) => {
  const path = `${CORPUS}/${PROJECT}/${sessionId}.json`
  const stats = statSync(path)
  const raw = readFileSync(path)
  return {
    bytes: stats.size,
    mtimeMs: Math.round(stats.mtimeMs),
    sha256: createHash('sha256').update(raw).digest('hex').slice(0, 12),
    pinned: /"pinned":\s*true/u.test(raw.toString('utf8'))
  }
}

const steps = []
const main = async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith('devtools://'))
  page.setDefaultTimeout(30000)

  const clickByBox = async (finder, label, arg) => {
    const box = await page.evaluate(finder, arg)
    if (!box || box.missing) return { label, clicked: false, box }
    await page.mouse.click(box.x, box.y)
    return { label, clicked: true, text: box.text }
  }

  // A reload gives a cold store: every session arrives as a summary, and only the selected one is read.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(9000)
  steps.push({
    label: 'after reload',
    view: await page.evaluate(() =>
      (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 100)
    )
  })

  // 1. Open session A from the Home row.
  steps.push(
    await clickByBox(
      (wanted) => {
        const row = Array.from(document.querySelectorAll('button')).find((button) =>
          (button.innerText || '').includes(wanted)
        )
        if (!row) return { missing: true }
        const rect = row.getBoundingClientRect()
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          text: (row.innerText || '').slice(0, 50)
        }
      },
      'open A from a Home row',
      A_MATCH
    )
  )
  await page.waitForTimeout(8000)
  steps.push({
    label: 'workspace + A rendered',
    transcriptHasA: await page.evaluate(
      (wanted) => (document.body.innerText || '').includes(wanted),
      A_MATCH
    ),
    navRows: await page.evaluate(() =>
      Array.from(document.querySelectorAll('nav[aria-label="Sessions"] button')).map((button) =>
        (button.getAttribute('aria-label') || button.innerText || '')
          .replace(/\s+/g, ' ')
          .slice(0, 46)
      )
    )
  })

  const openMenuFor = (wanted) => {
    const finder = (needle) => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
        (candidate.getAttribute('aria-label') || '').startsWith('Open actions for ')
          ? (candidate.getAttribute('aria-label') || '').includes(needle)
          : false
      )
      if (!button) return { missing: true }
      const rect = button.getBoundingClientRect()
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        text: button.getAttribute('aria-label')
      }
    }
    return { finder, arg: wanted }
  }
  const clickPinItem = () => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((candidate) =>
      /pin|置顶|固定/i.test(candidate.innerText || '')
    )
    if (!item) {
      return {
        missing: true,
        items: Array.from(document.querySelectorAll('[role="menuitem"]')).map((candidate) =>
          (candidate.innerText || '').trim()
        )
      }
    }
    const rect = item.getBoundingClientRect()
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      text: (item.innerText || '').trim()
    }
  }

  // 2. Pin B while the store holds it as a summary.
  const before = fileState(B_ID)
  steps.push({ label: 'B file BEFORE pin attempt', ...before })
  const menuForB = openMenuFor(B_MATCH)
  steps.push(await clickByBox(menuForB.finder, 'open B action menu (1st)', menuForB.arg))
  await page.waitForTimeout(1500)
  steps.push(await clickByBox(clickPinItem, 'click pin (B is a summary)'))
  await page.waitForTimeout(5000)
  const afterRefused = fileState(B_ID)
  steps.push({ label: 'B file AFTER pin attempt', ...afterRefused })
  steps.push({
    label: 'guard refused the write',
    ok: afterRefused.sha256 === before.sha256 && afterRefused.mtimeMs === before.mtimeMs
  })

  // 3. Open B for real: the document read clears the summary mark.
  steps.push(
    await clickByBox(
      (wanted) => {
        const row = Array.from(document.querySelectorAll('nav[aria-label="Sessions"] button')).find(
          (button) => (button.innerText || '').includes(wanted)
        )
        if (!row) return { missing: true }
        const rect = row.getBoundingClientRect()
        return {
          x: rect.x + Math.min(70, rect.width / 2),
          y: rect.y + rect.height / 2,
          text: (row.innerText || '').slice(0, 40)
        }
      },
      'open B from the sidebar',
      B_MATCH
    )
  )
  await page.waitForTimeout(8000)
  steps.push({
    label: 'B rendered after the document read',
    transcriptHasB: await page.evaluate(
      (wanted) => (document.body.innerText || '').includes(wanted),
      B_MATCH
    )
  })

  // 4. The same edit again: this time it must reach the disk.
  steps.push(await clickByBox(menuForB.finder, 'open B action menu (2nd)', menuForB.arg))
  await page.waitForTimeout(1500)
  steps.push(await clickByBox(clickPinItem, 'click pin (B already read)'))
  await page.waitForTimeout(6000)
  const afterAllowed = fileState(B_ID)
  steps.push({ label: 'B file AFTER the document was read', ...afterAllowed })
  steps.push({
    label: 'write landed once the document was read',
    ok: afterAllowed.sha256 !== before.sha256 && afterAllowed.pinned === true
  })

  console.log(JSON.stringify(steps, null, 1))
  await browser.close()
}

main().catch((error) => {
  console.log('PROBE_ERROR ' + error.message)
  console.log(JSON.stringify(steps, null, 1))
  process.exit(1)
})
