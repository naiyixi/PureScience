import { linkSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// V5 / A7: the DOWNLOAD half of the lock import. v1.81.0's release page carries this as an open item —
// 「A7 的下载路径未实测（`allowDownload:true` 时从锁里的 URL 取包并建成环境）：验收用例刻意关掉下载以保证
// 与网络无关 ⇒ 立案」. The sibling spec proves the cache path with zero network bytes; this one proves the
// other half without needing the public host to be reachable, by serving ONE package from a local HTTP
// server and seeding the cache with the other eighty-one.
//
// Why exactly one entry is enough, and why this shape: the cache is a flat directory keyed by file name, so
// a package the cache already holds can never exercise the download path. Seeding all but one forces that
// single entry to come over HTTP, while leaving the lock's URL shape, the file name and the md5 fragment
// untouched — so a pass means the downloaded bytes really were verified against the lock, not that the
// assertion was easy to satisfy.
//
// Three readings, three tests: the download happens and the environment builds; downloads OFF names the
// missing entry instead of building something partial; and a corrupted byte is refused whole, naming the
// entry, with no environment left behind.
const REAL_RUNTIME_ROOT = join(homedir(), '.purescience', 'runtime')
const PACK_SUBDIR = process.platform === 'darwin' ? 'osx-arm64' : 'linux-64'
const PACK_DIR = join(REAL_RUNTIME_ROOT, 'packs', '1', PACK_SUBDIR, 'python-3.12')
const PACK_LOCK = join(PACK_DIR, 'python-3.12.lock')

process.env.PURESCIENCE_MICROMAMBA_BIN = join(REAL_RUNTIME_ROOT, 'micromamba', 'bin', 'micromamba')

test.setTimeout(600_000)

const instanceDataRoot = (storageRoot: string): string => join(storageRoot, 'PureScience-DEV')

type LockEntry = { line: string; url: string; file: string; md5: string }

const parseLock = (text: string): LockEntry[] =>
  text
    .split('\n')
    .map((raw) => raw.trim())
    .filter((line) => /^https?:\/\//.test(line))
    .map((line) => {
      const [url, md5 = ''] = line.split('#')
      return { line, url, md5, file: url.slice(url.lastIndexOf('/') + 1) }
    })

// Seeds every entry EXCEPT `skip`, so exactly that one has to be fetched. Hard links keep this read-only
// against the curated pack.
const seedCacheExcept = (storageRoot: string, entries: LockEntry[], skip: string): number => {
  const cache = join(instanceDataRoot(storageRoot), 'runtime', 'pkgs')
  mkdirSync(cache, { recursive: true })
  let seeded = 0
  for (const entry of entries) {
    if (entry.file === skip) continue
    linkSync(join(PACK_DIR, entry.file), join(cache, entry.file))
    seeded += 1
  }
  return seeded
}

// Serves one package over 127.0.0.1, optionally with a single byte flipped (the bad-checksum reading).
const servePackage = async (
  file: string,
  corrupt: boolean
): Promise<{ server: Server; port: number; bytes: number }> => {
  const original = readFileSync(join(PACK_DIR, file))
  const payload = corrupt ? Buffer.from(original) : original
  if (corrupt) payload[0] = payload[0] ^ 0xff
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': payload.length
    })
    response.end(payload)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, bytes: original.length }
}

const openRuntimes = async (page: Page): Promise<ReturnType<Page['getByRole']>> => {
  const entry = page.getByRole('button', { name: 'Model settings' })
  const entryIsThere = await entry
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (entryIsThere) await entry.first().click()
  else await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+,`)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Runtimes' })
    .click()

  return settings
}

const setDownloads = async (
  dialog: ReturnType<Page['getByTestId']>,
  on: boolean
): Promise<void> => {
  const toggle = dialog.getByRole('switch', {
    name: 'Download packages missing from the local cache'
  })
  if ((await toggle.isChecked()) !== on) await toggle.click()
}

// Fills the import dialog and submits; returns the dialog for the caller's own assertions.
const submitImport = async (
  page: Page,
  lockText: string,
  name: string,
  downloads: boolean
): Promise<ReturnType<Page['getByTestId']>> => {
  const settings = await openRuntimes(page)
  await settings.getByTestId('runtime-import-lock-python').click()
  const dialog = page.getByTestId('runtime-import-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('runtime-import-name').fill(name)
  await dialog.getByTestId('runtime-import-lock').fill(lockText)
  await setDownloads(dialog, downloads)
  await dialog.getByTestId('runtime-import-submit').click()

  return dialog
}

test('a package missing from the cache is downloaded from the lock URL and verified against its md5', async ({
  app
}) => {
  test.skip(!lockExists(), 'no curated pack on this machine')
  const entries = parseLock(readFileSync(PACK_LOCK, 'utf8'))
  // The entry that has to travel: a small one keeps the run short.
  const target = entries.reduce((smallest, entry) =>
    statSync(join(PACK_DIR, entry.file)).size < statSync(join(PACK_DIR, smallest.file)).size
      ? entry
      : smallest
  )
  const { server, port, bytes } = await servePackage(target.file, false)
  try {
    const seeded = seedCacheExcept(app.storageRoot, entries, target.file)
    console.log(
      `[v5] entries=${entries.length} seeded=${seeded} downloadTarget=${target.file} (${bytes}B) via 127.0.0.1:${port}`
    )

    const lock = readFileSync(PACK_LOCK, 'utf8').replace(
      target.url,
      `http://127.0.0.1:${port}/${target.file}`
    )
    const page = await app.completeOnboarding()
    const dialog = await submitImport(page, lock, 'download-env', true)
    await expect(dialog.getByTestId('runtime-import-status')).toContainText('download-env', {
      timeout: 300_000
    })
    const status = (await dialog.getByTestId('runtime-import-status').innerText()).replace(
      /\s+/g,
      ' '
    )
    console.log(`[v5] status: ${status}`)
    expect(status).toContain('1 downloaded')
    expect(await dialog.getByTestId('runtime-import-missing-entry').count()).toBe(0)

    // The environment is real and the downloaded package is in it (the interpreter answers).
    const envDir = join(instanceDataRoot(app.storageRoot), 'runtime', 'envs', 'download-env')
    expect(statSync(join(envDir, 'bin', 'python')).size).toBeGreaterThan(0)
    console.log('[v5] environment built from a verified download')
  } finally {
    server.close()
  }
})

test('with downloads off, the missing entry is named instead of building something partial', async ({
  app
}) => {
  test.skip(!lockExists(), 'no curated pack on this machine')
  const entries = parseLock(readFileSync(PACK_LOCK, 'utf8'))
  const target = entries[0]
  const seeded = seedCacheExcept(app.storageRoot, entries, target.file)
  console.log(`[v5-off] entries=${entries.length} seeded=${seeded} withheld=${target.file}`)

  const page = await app.completeOnboarding()
  const dialog = await submitImport(page, readFileSync(PACK_LOCK, 'utf8'), 'no-download-env', false)

  // The import cannot complete: the entry is not in the cache and downloads are off. Whatever the panel
  // says, it must name that entry rather than pass silently.
  await expect(dialog.getByTestId('runtime-import-missing-entry').first()).toBeVisible({
    timeout: 120_000
  })
  const named = await dialog.getByTestId('runtime-import-missing-entry').first().innerText()
  console.log(`[v5-off] named missing entry: ${named.replace(/\s+/g, ' ').slice(0, 160)}`)
  expect(named).toContain(target.file)
})

test('a corrupted byte is refused whole, naming the entry, with no environment left behind', async ({
  app
}) => {
  test.skip(!lockExists(), 'no curated pack on this machine')
  const entries = parseLock(readFileSync(PACK_LOCK, 'utf8'))
  const target = entries.reduce((smallest, entry) =>
    statSync(join(PACK_DIR, entry.file)).size < statSync(join(PACK_DIR, smallest.file)).size
      ? entry
      : smallest
  )
  const { server, port } = await servePackage(target.file, true)
  try {
    const seeded = seedCacheExcept(app.storageRoot, entries, target.file)
    console.log(
      `[v5-bad] seeded=${seeded} corrupted=${target.file} (md5 in lock stays ${target.md5.slice(0, 8)}…)`
    )
    const lock = readFileSync(PACK_LOCK, 'utf8').replace(
      target.url,
      `http://127.0.0.1:${port}/${target.file}`
    )
    const page = await app.completeOnboarding()
    const dialog = await submitImport(page, lock, 'bad-md5-env', true)
    await expect(dialog.getByTestId('runtime-import-missing-entry').first()).toBeVisible({
      timeout: 300_000
    })
    const named = await dialog.getByTestId('runtime-import-missing-entry').first().innerText()
    console.log(`[v5-bad] named: ${named.replace(/\s+/g, ' ').slice(0, 200)}`)
    expect(named).toContain(target.file)

    // Refused whole: no environment may exist under that name.
    const envDir = join(instanceDataRoot(app.storageRoot), 'runtime', 'envs', 'bad-md5-env')
    expect(existsSyncSafe(envDir)).toBe(false)
    console.log('[v5-bad] no environment was built')
  } finally {
    server.close()
  }
})

function lockExists(): boolean {
  try {
    return statSync(PACK_LOCK).isFile()
  } catch {
    return false
  }
}

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
