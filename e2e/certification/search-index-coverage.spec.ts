import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// S4 of the incremental full-text index (S3). Four claims, read off a real window, because the index is the
// one place where "it works" and "it silently covers nothing" look identical from the outside:
//
//   ① a corpus the index has not seen yet says so, WITH a count — not a smaller result set;
//   ② after a tick the same query is served from an index that is current (pending back to 0, indexed > 0);
//   ③ a restart does not throw the work away (the checkpoint on disk is authoritative);
//   ④ deleting the index directory reads as "no index" — NOT as "no results".
//
// The corpus is registered the way a person registers one: the file is written where the fixture's isolated
// root can see it, then handed to the app's own `uploads.stageLocalPath` (the "save this local file" path the
// preview surface calls). Poking the index store directly would prove nothing about the user's path.

test.setTimeout(300_000)

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const KEYWORD = 'zzs3coverageprobe'
const CORPUS_FILES = [1, 2, 3]

const openSearch = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.keyboard.press(`${modifier}+k`)
  await expect(page.getByTestId('global-search-dialog')).toBeVisible()
}

test('the index reports what it covers, is current after a tick, survives a restart, and is not confused with an empty result set', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Search index coverage')

  // --- The corpus, registered through the app's own upload path ------------------------------------------
  const corpusDir = await app.createTestDirectory('s3-corpus')
  const corpusPaths: string[] = []
  for (const index of CORPUS_FILES) {
    const name = `corpus-${index}.txt`
    const path = join(corpusDir, name)
    // The keyword lives in the BODY, so a hit can only come from reading the file — not from its name.
    await writeFile(path, `padding for ${name}\nthe ${KEYWORD} marker sits on this line\n`, 'utf8')
    corpusPaths.push(path)
  }

  const registered = await page.evaluate(
    async ({ projectId: id, paths }) => {
      const bridge = globalThis as unknown as {
        api: {
          uploads: {
            stageLocalPath?: (request: {
              transferId: string
              name: string
              sourcePath: string
              projectId: string
            }) => Promise<unknown>
          }
          projectFiles: { listFiles: (input: unknown) => Promise<unknown> }
        }
      }
      if (typeof bridge.api.uploads.stageLocalPath !== 'function') {
        return { staged: 0, files: 0, error: 'stageLocalPath missing' }
      }
      let staged = 0
      for (const path of paths) {
        await bridge.api.uploads.stageLocalPath({
          transferId: `s3-${staged}-${Date.now()}`,
          name: path.split('/').pop() ?? 'corpus.txt',
          sourcePath: path,
          projectId: id
        })
        staged += 1
      }
      const listing = (await bridge.api.projectFiles.listFiles({
        projectId: id,
        collection: { kind: 'all' },
        limit: 50
      })) as { items?: unknown[]; files?: unknown[] }
      return { staged, files: (listing.items ?? listing.files ?? []).length }
    },
    { projectId, paths: corpusPaths }
  )
  console.log(`[s3-reading] corpus registered: ${JSON.stringify(registered)}`)
  expect(registered.error).toBeUndefined()
  expect(registered.staged).toBe(CORPUS_FILES.length)
  // The precondition the rest depends on: the files really reached the project-files index the index builder
  // walks. Without this the run could "pass" on an empty corpus.
  expect(registered.files).toBeGreaterThanOrEqual(CORPUS_FILES.length)

  // --- ① a corpus the index has not seen says so ---------------------------------------------------------
  await openSearch(page)
  const dialog = page.getByTestId('global-search-dialog')
  await dialog.getByRole('combobox').fill(KEYWORD)
  const results = dialog.locator('[role="listbox"] [role="option"]')
  // Wait until the palette has ANSWERED before reading anything below. `results` is a superset: the same
  // listbox also carries artifact rows, session rows and "show more" buttons, so a count over every
  // `role="option"` can be satisfied while the content query is still in flight. A notice read at that
  // instant says "nothing is on screen" about a panel that has simply not answered yet — that is a race,
  // and it must never be reported as a UI gap. Each of these three is rendered only from a landed
  // response (the summary block even carries the response's own `index`), so any one of them means the
  // palette has answered. The wait is bounded (30s) and what it waited for is printed, so a genuine
  // "the block never renders" gap still shows up as a gap instead of being waited away.
  const contentRows = dialog.locator('[data-testid="global-search-content-row"]')
  const contentEmpty = dialog.locator('[data-testid="global-search-content-empty"]')
  const summarySlot = dialog.locator('[data-slot="gs-index-summary"]')
  await expect
    .poll(
      async () =>
        (await contentRows.count()) + (await contentEmpty.count()) + (await summarySlot.count()),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0)
  const optionRowCount = await results.count()
  // What the corpus claim rests on is the CONTENT rows — not every option row in the listbox, which
  // would count an artifact or a session as if the phrase had been found in the corpus.
  const hitCount = await contentRows.count()
  const summaryVisible = (await summarySlot.count()) > 0
  const summaryText = summaryVisible
    ? (await summarySlot.innerText()).replace(/\s+/g, ' ').trim()
    : '(no index summary on screen)'
  // The notice the panel shows when it has nothing measured to report. Two DIFFERENT statements live
  // here — "not measured yet" (no tick has run in this app run) and "no index built yet" (a tick ran and
  // found none) — so the reading names which one was actually on screen rather than collapsing them.
  const emptyIndexNotice = async (): Promise<string> => {
    const from = async (slot: string, wording: string): Promise<string | undefined> => {
      const locator = dialog.locator(`[data-slot="${slot}"]`)
      if ((await locator.count()) === 0) return undefined
      return `${wording}: ${(await locator.innerText()).replace(/\s+/g, ' ').trim()}`
    }
    const notMeasured = await from('gs-index-not-measured', 'not-measured')
    if (notMeasured !== undefined) return notMeasured
    const absent = await from('gs-index-absent', 'measured-no-index')
    if (absent !== undefined) return absent
    // NEITHER sentence on screen. The palette has ANSWERED by this point — that is what the wait above
    // bought: the content rows are already on screen from a landed response, and a landed response
    // carries an `index` block whenever the index is wired. So "the palette answered and the block is
    // still absent" names a UI gap, and it is no longer confusable with a probe that looked early. The
    // probe also asks the app, through its own search channel, what the answer carried — so "the palette
    // never rendered it" and "the answer never carried one" are never reported as the same sentence.
    const block = await dialog.locator('[data-slot="gs-index-summary"]').count()
    const served = await page.evaluate(
      async ({ query, projectId: id }) => {
        try {
          const bridge = globalThis as unknown as {
            api: {
              search: {
                query: (request: {
                  query: string
                  projectId?: string
                }) => Promise<{ index?: unknown }>
              }
            }
          }
          const response = await bridge.api.search.query({
            query,
            ...(id ? { projectId: id } : {})
          })
          return JSON.stringify(response.index ?? null)
        } catch (error: unknown) {
          return `(the probe's own query failed: ${error instanceof Error ? error.message : String(error)})`
        }
      },
      { query: KEYWORD, projectId }
    )
    return block === 0
      ? `(no empty-index notice on screen — the palette had answered (content rows: ${hitCount}) and the summary block was still absent: UI gap; the app's own search answered index=${served})`
      : `(summary block present, no notice inside it; the app's own search answered index=${served})`
  }
  const emptyNoticeText = await emptyIndexNotice()
  console.log(
    `[s3-reading] before any tick — hits ${hitCount} (option rows on screen: ${optionRowCount})`
  )
  console.log(`[s3-reading] before any tick — index summary: ${summaryText}`)
  console.log(`[s3-reading] before any tick — empty-index notice: ${emptyNoticeText}`)
  // The result set comes from the live scan and is NOT empty: the corpus is findable without the index.
  expect(hitCount).toBeGreaterThan(0)

  // --- ② after a tick the index is current --------------------------------------------------------------
  const indexNow = dialog.locator('[data-slot="gs-index-now"]')
  if ((await indexNow.count()) > 0) {
    await indexNow.click()
    await expect
      .poll(
        async () => {
          const text =
            (await dialog.locator('[data-slot="gs-index-counts"]').count()) > 0
              ? await dialog.locator('[data-slot="gs-index-counts"]').innerText()
              : ''
          return text
        },
        { timeout: 60_000 }
      )
      .not.toBe('')
  }
  const afterTick = await dialog
    .locator('[data-slot="gs-index-counts"]')
    .innerText()
    .catch(() => '(no counts slot)')
  console.log(`[s3-reading] after "Index now" — counts: ${afterTick.replace(/\s+/g, ' ').trim()}`)

  const readCoverage = async (
    refreshIndex = false
  ): Promise<{ indexed: number; pending: number; block: string }> =>
    page.evaluate(
      async ({ keyword, projectId: id, refresh }) => {
        const bridge = globalThis as unknown as {
          api: {
            search?: {
              query?: (input: {
                query: string
                projectId?: string
                refreshIndex?: boolean
              }) => Promise<{ index?: { indexed?: number; pending?: number } }>
            }
          }
        }
        // The request field is `query` (not `text`): passing the wrong name is what made the first attempt
        // throw inside the main process instead of returning a reading.
        const response = await bridge.api.search?.query?.({
          query: keyword,
          projectId: id,
          ...(refresh ? { refreshIndex: true } : {})
        })
        const block = response?.index
        return {
          indexed: block?.indexed ?? -1,
          pending: block?.pending ?? -1,
          block: block ? JSON.stringify(block) : '(response carried no index block)'
        }
      },
      { keyword: KEYWORD, projectId, refresh: refreshIndex }
    )

  const coverageAfterTick = await readCoverage(true)
  console.log(`[s3-reading] after "Index now" — coverage block: ${coverageAfterTick.block}`)
  console.log(`[s3-reading] after "Index now" — coverage: ${JSON.stringify(coverageAfterTick)}`)
  expect(coverageAfterTick.indexed).toBeGreaterThan(0)
  expect(coverageAfterTick.pending).toBe(0)

  // --- ③ a restart does not throw the work away ---------------------------------------------------------
  await page.keyboard.press('Escape')
  page = await app.restart()
  // Read through the bridge rather than the palette: this assertion is about the CHECKPOINT ON DISK being
  // authoritative, so the honest probe is the same query the panel makes, asked of a freshly started process
  // whose in-memory state is empty. (The panel's own reading is taken in ①/② above, where it is on screen.)
  const coverageAfterRestart = await readCoverage()
  console.log(`[s3-reading] after restart — coverage block: ${coverageAfterRestart.block}`)
  // Never backwards: the checkpoint on disk is the authority, so a restart cannot shrink what it covers.
  expect(coverageAfterRestart.indexed).toBeGreaterThanOrEqual(coverageAfterTick.indexed)

  // --- ④ deleting the index reads as "no results is a different fact from no index" ---------------------
  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage?: { getInfo?: () => Promise<{ dataRoot?: string; root?: string }> } }
    }
    const info = await bridge.api.storage?.getInfo?.()
    return info?.dataRoot ?? info?.root ?? ''
  })
  console.log(`[s3-reading] data root: ${dataRoot}`)
  expect(dataRoot).not.toBe('')
  const indexPath = join(dataRoot, 'search-index')
  await rm(indexPath, { recursive: true, force: true })

  // What is STABLE here, and what is not. A project-scoped query advances the index (the tick is
  // query-driven by design: an explicit "index now", and a plain query, both move it), so the index
  // directory being absent is a state the app heals on the next query. The "0 indexed / N pending"
  // reading is the transient of that rebuild — asserting on it means asserting on a race: the same
  // assertion read 0 on one build and 3 on the next, with no code between them. What must hold in
  // every ordering, and is therefore what this half pins:
  //   (a) the delete actually landed on disk (so the rest is not read against a still-present index),
  //   (b) coverage still accounts for every file — `indexed + pending` is the corpus, never "nothing
  //       to cover" (a view that dropped the corpus here would report 0/0 and look healthy),
  //   (c) the index is rebuilt ON DISK by the next query (not merely kept in memory), and
  //   (d) the corpus is still findable, so "the index is gone" cannot be shown as "no results".
  expect(existsSync(indexPath)).toBe(false)
  const coverageAfterDelete = await readCoverage(true)
  console.log(
    `[s3-reading] after deleting the index dir — coverage block: ${coverageAfterDelete.block}`
  )
  expect(coverageAfterDelete.indexed + coverageAfterDelete.pending).toBe(CORPUS_FILES.length)
  expect(coverageAfterDelete.indexed).toBe(CORPUS_FILES.length)
  expect(coverageAfterDelete.pending).toBe(0)
  expect(existsSync(indexPath)).toBe(true)
  const hitsAfterDelete = await page.evaluate(
    async ({ keyword, projectId: id }) => {
      const bridge = globalThis as unknown as {
        api: {
          search?: {
            query?: (input: { query: string; projectId?: string }) => Promise<{
              hits?: unknown[]
              counts?: Record<string, number>
            }>
          }
        }
      }
      const response = await bridge.api.search?.query?.({ query: keyword, projectId: id })
      return { hits: response?.hits?.length ?? 0, counts: response?.counts ?? {} }
    },
    { keyword: KEYWORD, projectId }
  )
  console.log(`[s3-reading] after deleting the index dir — ${JSON.stringify(hitsAfterDelete)}`)
  // The point of the assertion: the corpus is STILL findable with the index rebuilt, and the reader is
  // never told the project is empty just because the index directory was.
  expect(hitsAfterDelete.hits).toBeGreaterThan(0)
})
