// Startup timeline instrument (W0/N2 baseline).
//
// Measures, on a real Electron launch against isolated roots:
//   spawn → [startup-step] window-created   (the app's own durable marker)
//   spawn → [startup-step] tray-created     (startup path complete)
//   spawn → composer visible & usable       (what "interactive" means for a user)
//   resident memory once idle
//
// The marker lines are written with writeSync to fd 1, so they arrive even when the
// main thread stalls; they are the only startup reads that survive a stuck launch.
//
// Usage: node scripts/perf/startup-timeline.mjs [runs]
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const APP_ROOT = resolve(process.cwd())
const RUNS = Number(process.argv[2] ?? 3)
const PORT = 9333 + Math.floor(Math.random() * 200)

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}

const rssTree = (pid) => {
  // Sum resident size of the main process and every descendant (renderer, GPU, utility).
  try {
    const out = spawnSyncPs()
    const rows = out
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((r) => r.length >= 3)
    const children = new Map()
    for (const [p, pp] of rows) {
      if (!children.has(pp)) children.set(pp, [])
      children.get(pp).push(p)
    }
    const byPid = new Map(rows.map(([p, , kb]) => [p, Number(kb)]))
    const stack = [String(pid)]
    let total = 0
    const seen = new Set()
    while (stack.length) {
      const p = stack.pop()
      if (seen.has(p)) continue
      seen.add(p)
      total += byPid.get(p) ?? 0
      for (const c of children.get(p) ?? []) stack.push(c)
    }
    return Math.round(total / 1024)
  } catch {
    return null
  }
}

function spawnSyncPs() {
  const r = require('node:child_process').spawnSync('ps', ['-Ao', 'pid,ppid,rss'], {
    encoding: 'utf8'
  })
  return r.stdout ?? ''
}

const runOnce = async (index) => {
  const root = mkdtempSync(join(tmpdir(), `ps-startup-${index}-`))
  const configRoot = join(root, 'config')
  const dataRoot = join(root, 'data')
  mkdirSync(configRoot, { recursive: true })
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(
    join(configRoot, 'settings.json'),
    JSON.stringify({ version: 2, onboardingCompletedAt: Date.now(), dataRoot }, null, 1)
  )
  const userDataRoot = join(root, 'userdata')
  mkdirSync(userDataRoot, { recursive: true })

  const startedAt = Date.now()
  const child = spawn(
    resolve(APP_ROOT, 'node_modules', '.bin', 'electron'),
    [
      APP_ROOT,
      '--lang=en-US',
      `--user-data-dir=${userDataRoot}`,
      `--remote-debugging-port=${PORT}`
    ],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        PURESCIENCE_STORAGE_ROOT: configRoot,
        ELECTRON_ENABLE_LOGGING: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  const marks = {}
  let buffer = ''
  const onData = (chunk) => {
    buffer += chunk.toString()
    for (const line of buffer.split('\n')) {
      const m = line.match(/\[startup-step\] ([a-z-]+) at (\S+)/)
      if (m && marks[m[1]] === undefined) {
        const at = Date.parse(m[2])
        marks[m[1]] = Number.isFinite(at) ? at - startedAt : Date.now() - startedAt
      }
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  let interactiveMs = null
  let windowVisibleMs = null
  let browser = null
  try {
    // Poll the debugger endpoint, then attach: "interactive" is the composer accepting input.
    const deadline = Date.now() + 90_000
    // The endpoint answers before the page target exists, so attach-then-count must retry:
    // an empty target list here is a timing artefact, not a missing window.
    let page = null
    while (!page) {
      if (Date.now() > deadline) throw new Error('no page target over CDP within 90s')
      try {
        if (!browser) browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
        const pages = browser.contexts().flatMap((c) => c.pages())
        if (pages.length) page = pages[0]
      } catch {
        browser = null
      }
      if (!page) await new Promise((r) => setTimeout(r, 250))
    }
    // "Interactive" = the home shell is painted AND the primary action is clickable.
    // The composer only exists inside a session, so it cannot be the home-screen criterion.
    await page.waitForSelector('[data-slot="app-version"]', { timeout: 90_000 })
    await page
      .getByRole('button', { name: 'New project' })
      .waitFor({ state: 'visible', timeout: 90_000 })
    interactiveMs = Date.now() - startedAt
    windowVisibleMs = marks['window-created'] ?? null
    await page.waitForTimeout(1200)
  } catch (error) {
    marks.error = String(error && error.message ? error.message : error)
  }

  const memoryMb = rssTree(child.pid)
  try {
    if (browser) await browser.close()
  } catch {
    /* CDP close is best-effort */
  }
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 1200))
  if (child.exitCode === null) child.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 400))
  rmSync(root, { recursive: true, force: true })

  return {
    run: index,
    spawnToWindowMs: windowVisibleMs,
    spawnToTrayMs: marks['tray-created'] ?? null,
    spawnToInteractiveMs: interactiveMs,
    memoryMb,
    error: marks.error
  }
}

const results = []
for (let i = 1; i <= RUNS; i += 1) {
  const r = await runOnce(i)
  results.push(r)
  console.log(JSON.stringify(r))
}

const pick = (k) => results.map((r) => r[k]).filter((v) => typeof v === 'number')
const summary = {}
for (const k of ['spawnToWindowMs', 'spawnToTrayMs', 'spawnToInteractiveMs', 'memoryMb']) {
  const v = pick(k)
  summary[k] = v.length
    ? { median: median(v), runs: v }
    : { median: null, runs: [], note: 'no reading' }
}
console.log('\nSUMMARY ' + JSON.stringify(summary))
