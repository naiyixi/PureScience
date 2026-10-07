import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

/**
 * IC10 — a session package's evidence has to become ROWS on the machine that imports it, not just
 * travel inside the archive.
 *
 * Everything below goes through the window's own bridge (the same one the dialogs call): a citation is
 * created in the source project, a review is run for the source turn, a search hit is pinned to that
 * review by hand, the session is exported to a real `.science` package, and the package is imported
 * into a SECOND project. What the spec then reads back is the receiving machine's stores — a citation
 * in the target project's library, a review under the imported session, and the pin — never the
 * package's own claim about what it carried.
 */

test.setTimeout(300_000)

type EvidenceLanding = {
  citations: number
  reviews: number
  reviewFindings: number
  verificationRecords: number
  skipped: Array<{ kind: string; reason: string; id?: string }>
}

type Bridge = {
  api: {
    sessions: {
      loadAll: () => Promise<unknown>
      exportPackage: (request: {
        projectId: string
        sessionId: string
        mode: 'essential' | 'full'
        destinationPath?: string
      }) => Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }>
      importPackage: (request: {
        packagePath: string
        confirm?: { targetProjectId?: string }
      }) => Promise<{ ok: boolean; sessionId?: string; reason?: string; landed?: EvidenceLanding }>
    }
    references: {
      add: (input: unknown) => Promise<{
        status: 'created' | 'duplicate'
        reference?: { id: string; title: string; citationKey: string }
      }>
      list: (
        projectId: string
      ) => Promise<Array<{ id: string; title: string; citationKey: string }>>
    }
    reviewer: {
      run: (request: unknown) => Promise<{ started: boolean; reason?: string }>
      getForSession: (request: { projectId: string; appSessionId: string }) => Promise<
        Array<{
          id: string
          turnMessageId: string
          lifecycle?: string
          outcome?: string | null
          checks?: unknown[]
        }>
      >
      evidence: (request: unknown) => Promise<{
        attachments?: Array<{ id: string; fingerprint: string; reviewId: string }>
      }>
    }
    search: {
      evidence: (request: unknown) => Promise<{ status: string; line?: { fingerprint: string } }>
    }
  }
}

type Turn = { sessionId: string; messageId: string }

// A compact, self-describing reading of the sender's review rows, so the log says WHICH rows the package
// carried (lifecycle/outcome/checks) instead of only how many.
const reviewShape = (
  reviews: Array<{ lifecycle?: string; outcome?: string | null; checks?: unknown[] }>
): string =>
  reviews
    .map(
      (review) =>
        `${review.lifecycle ?? '?'}/${review.outcome ?? 'null'}:${review.checks?.length ?? 0}`
    )
    .join('|')

// The turn's ids come from the app's own session record — never from a guess about storage layout.
const readSourceTurn = async (page: Page, title: string): Promise<Turn> => {
  let found: Turn | undefined
  await expect
    .poll(
      async () => {
        found = await page.evaluate(async (wanted) => {
          const bridge = globalThis as unknown as Bridge
          const raw = await bridge.api.sessions.loadAll()
          const list = Array.isArray(raw)
            ? raw
            : ((raw as { sessions?: unknown }).sessions ?? (raw as { items?: unknown }).items)
          const sessions = Array.isArray(list) ? list : []
          const session = (sessions as Array<Record<string, unknown>>).find((candidate) =>
            String(candidate.title ?? '').includes(wanted)
          )
          if (!session) return undefined
          const messages = (session.messages ?? []) as Array<{ id: string; role?: string }>
          if (messages.length === 0) return undefined
          const last = messages[messages.length - 1]
          const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
          return { sessionId: String(session.id), messageId: (assistant ?? last).id }
        }, title)
        return found
      },
      { timeout: 60_000 }
    )
    .toBeTruthy()
  return found!
}

const exportPackage = (
  page: Page,
  request: {
    projectId: string
    sessionId: string
    mode: 'essential' | 'full'
    destinationPath?: string
  }
): Promise<{ ok: boolean; path?: string; error?: string }> =>
  page.evaluate(async (payload) => {
    const bridge = globalThis as unknown as Bridge
    return bridge.api.sessions.exportPackage(payload)
  }, request)

const importPackage = (
  page: Page,
  packagePath: string,
  targetProjectId: string
): Promise<{ ok: boolean; sessionId?: string; reason?: string; landed?: EvidenceLanding }> =>
  page.evaluate(
    async (payload) => {
      const bridge = globalThis as unknown as Bridge
      return bridge.api.sessions.importPackage({
        packagePath: payload.packagePath,
        confirm: { targetProjectId: payload.targetProjectId }
      })
    },
    { packagePath, targetProjectId }
  )

test('a package’s evidence becomes rows on the machine that imports it', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  const prompt = 'Summarise the docking run'
  const sourceProjectId = await createProject(page, 'IC10 source')
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeEnabled({
    timeout: 120_000
  })

  const source = await readSourceTurn(page, prompt)

  // 1) A citation in the source project's library.
  const citation = await page.evaluate(async (projectId) => {
    const bridge = globalThis as unknown as Bridge
    return bridge.api.references.add({
      projectId,
      title: 'Molecular docking of nirmatrelvir',
      authors: [{ name: 'Zhang' }],
      year: 2023,
      sourceConnector: 'manual'
    })
  }, sourceProjectId)
  expect(citation.status).toBe('created')
  expect(citation.reference?.title).toBe('Molecular docking of nirmatrelvir')

  // 2) A review row for the source turn.
  const run = await page.evaluate(
    async (request) => {
      const bridge = globalThis as unknown as Bridge
      return bridge.api.reviewer.run(request)
    },
    { projectId: sourceProjectId, sessionId: source.sessionId, turnMessageId: source.messageId }
  )
  expect(run.started).toBe(true)

  const readSourceReviews = (): Promise<
    Array<{ id: string; lifecycle?: string; outcome?: string | null; checks?: unknown[] }>
  > =>
    page.evaluate(
      async (request) => {
        const bridge = globalThis as unknown as Bridge
        return bridge.api.reviewer.getForSession(request)
      },
      { projectId: sourceProjectId, appSessionId: source.sessionId }
    )

  // The app runs its own review at turn end, and this spec adds a second one of its own. A read that lands
  // while either is still being written sees a SMALLER set than the import then moves, so the landed count
  // and the source count disagree — measured, same code: locally 2/2 (17.5s, green) and on the mac lane 1/2
  // (red). The earlier wait here was a NEGATIVE one ("no review is `running`") and a negative predicate is
  // satisfied by a snapshot the app never settled into; what this needs is a POSITIVE one, so it polls until
  // two consecutive reads agree on the same set (id + lifecycle), then reads once.
  let previousFingerprint = ''
  await expect
    .poll(
      async () => {
        const reviews = await readSourceReviews()
        const fingerprint = reviews
          .map((review) => `${review.id}:${review.lifecycle ?? 'none'}`)
          .sort()
          .join('|')
        const settled = reviews.length > 0 && fingerprint === previousFingerprint
        previousFingerprint = fingerprint
        return settled
      },
      { timeout: 60_000 }
    )
    .toBe(true)
  const sourceReviews = await readSourceReviews()
  expect(sourceReviews.length).toBeGreaterThan(0)
  const sourceReviewId = sourceReviews[0].id

  // 3) A search hit captured from the transcript and pinned to that review by hand.
  const captured = await page.evaluate(
    async (request) => {
      const bridge = globalThis as unknown as Bridge
      return bridge.api.search.evidence(request)
    },
    {
      action: 'capture',
      projectId: sourceProjectId,
      sessionId: source.sessionId,
      messageId: source.messageId,
      query: 'docking',
      terms: ['docking']
    }
  )
  // A capture that did not happen fails here rather than being skipped: a spec that proceeds without
  // the fixture it needs reports success for work it never did.
  expect(captured.status, `capture returned ${JSON.stringify(captured)}`).toBe('captured')

  const attached = await page.evaluate(
    async (request) => {
      const bridge = globalThis as unknown as Bridge
      return bridge.api.reviewer.evidence(request)
    },
    { action: 'attach', reviewId: sourceReviewId, line: captured.line }
  )
  expect(JSON.stringify(attached)).not.toContain('rejection')

  // The counts the package is supposed to carry, read from the SENDER's own stores. Landing is judged
  // against these rather than a number this spec guessed: the app creates review rows of its own (auto
  // review runs at turn end), so the sender's evidence set is whatever it is — hard-coding "1 review"
  // reports a failure for a correct landing, and a duplicate on the receiving side would slip through a
  // hand-written number that happened to match.
  const sourceCitations = await page.evaluate(async (projectId) => {
    const bridge = globalThis as unknown as Bridge
    return bridge.api.references.list(projectId)
  }, sourceProjectId)
  const sourceFindings = sourceReviews.reduce(
    (total, review) => total + (review.checks?.length ?? 0),
    0
  )
  const sourcePins = await page.evaluate(
    async (reviewIds) => {
      const bridge = globalThis as unknown as Bridge
      const answer = await bridge.api.reviewer.evidence({ action: 'list', reviewIds })
      return answer.attachments ?? []
    },
    sourceReviews.map((review) => review.id)
  )
  console.log(
    `[ic10] source: citations=${sourceCitations.length} reviews=${reviewShape(sourceReviews)} findings=${sourceFindings} pins=${sourcePins.length}`
  )
  expect(sourceCitations.length).toBeGreaterThan(0)
  expect(sourceReviews.length).toBeGreaterThan(0)
  expect(sourcePins.length).toBeGreaterThan(0)

  // 4) A real package, written by the app's own export path.
  const directory = await app.createTestDirectory('ic10-package')
  const packagePath = `${directory}/source.science`
  const exported = await exportPackage(page, {
    projectId: sourceProjectId,
    sessionId: source.sessionId,
    mode: 'full',
    destinationPath: packagePath
  })
  expect(exported.ok, `export failed: ${JSON.stringify(exported)}`).toBe(true)

  // 5) Import into a SECOND, empty project: nothing can land by coincidence there. The workspace shows
  // one project at a time, so the second one is created from the project list like a reader would —
  // clicking "New project" while a session is open waits on a button that surface does not carry.
  await page.getByRole('button', { name: 'All projects' }).click()
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
  const targetProjectId = await createProject(page, 'IC10 target')
  const imported = await importPackage(page, packagePath, targetProjectId)
  expect(imported.ok, `import failed: ${JSON.stringify(imported)}`).toBe(true)
  const landed = imported.landed!
  console.log(`[ic10] landed: ${JSON.stringify(landed)}`)
  // Every dimension is accounted for: each row the package carried either landed on this machine or is
  // NAMED in `skipped`. The sender's evidence set includes review rows the app creates on its own (an
  // auto review at turn end) and those can point at a turn message the package's transcript does not
  // carry — the landing module refuses such a row BY NAME instead of landing it against the wrong turn.
  // So the invariant is "landed + named = carried", not "nothing was skipped": the latter reports a
  // correct, named refusal as a failure, which is exactly what it did on the first packaged run (one
  // ambient review row, `message-not-found`; see the queue's v1.84.0 item on package self-consistency).
  const sourceReviewIds = sourceReviews.map((review) => review.id)
  const skippedIds = new Set(landed.skipped.flatMap((row) => (row.id ? [row.id] : [])))
  const notLandedReviewIds = sourceReviewIds.filter((id) => skippedIds.has(id))
  const findingsOfLandedReviews = sourceReviews
    .filter((review) => !skippedIds.has(review.id))
    .reduce((total, review) => total + (review.checks?.length ?? 0), 0)

  // Row for row against the SENDER's own counts — a landing that duplicated a row, or dropped one
  // without naming it, reads as a mismatch here.
  expect(landed.citations, `source citations=${sourceCitations.length}`).toBe(
    sourceCitations.length
  )
  expect(
    landed.reviews,
    `source reviews=${reviewShape(sourceReviews)} notLanded=${JSON.stringify(notLandedReviewIds)} skipped=${JSON.stringify(landed.skipped)}`
  ).toBe(sourceReviews.length - notLandedReviewIds.length)
  expect(
    landed.reviewFindings,
    `source findings=${sourceFindings} notLanded=${JSON.stringify(notLandedReviewIds)}`
  ).toBe(findingsOfLandedReviews)
  // Citations and pins have no ambient rows — the spec made every one of them — so these stay exact.
  expect(landed.verificationRecords, `source pins=${sourcePins.length}`).toBe(sourcePins.length)
  // The rows THIS spec created are the ones it can vouch for: refusing any of them is a defect, not an
  // environment difference. (An ambient review row may be refused, but only by name — never silently.)
  expect(skippedIds.has(sourceReviewId), 'the review this spec ran must land').toBe(false)

  // 6) Read the receiving machine's own stores back — the counts must match what the package carried.
  const targetReferences = await page.evaluate(async (projectId) => {
    const bridge = globalThis as unknown as Bridge
    return bridge.api.references.list(projectId)
  }, targetProjectId)
  console.log(
    `[ic10] target citations: ${JSON.stringify(targetReferences.map((row) => row.title))}`
  )
  expect(targetReferences.map((row) => row.title)).toContain('Molecular docking of nirmatrelvir')
  // The library of the target project holds exactly the rows that landed — nothing pre-existing to be
  // confused with, this project was created empty one line above.
  expect(targetReferences.length).toBe(landed.citations)

  const targetReviews = await page.evaluate(
    async (request) => {
      const bridge = globalThis as unknown as Bridge
      return bridge.api.reviewer.getForSession(request)
    },
    { projectId: targetProjectId, appSessionId: imported.sessionId! }
  )
  console.log(`[ic10] target reviews: ${reviewShape(targetReviews)}`)
  expect(targetReviews.length).toBe(landed.reviews)

  const pinned = await page.evaluate(
    async (reviewIds) => {
      const bridge = globalThis as unknown as Bridge
      return bridge.api.reviewer.evidence({ action: 'list', reviewIds })
    },
    targetReviews.map((review) => review.id)
  )
  console.log(`[ic10] target pins: ${JSON.stringify(pinned.attachments ?? [])}`)
  expect(pinned.attachments?.length).toBe(landed.verificationRecords)
  // The pin stored here must be one this machine can re-check: a fingerprint is present.
  expect(pinned.attachments?.[0].fingerprint).toBeTruthy()
})
