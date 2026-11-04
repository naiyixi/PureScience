import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for reading text out of an image, on a real window: an image is attached through the composer's
// own file picker (the same path a reader uses, so it reaches the project-files index the panel reads), the
// panel's own button is clicked, and the panel must show either the recognised text together with the pack,
// engine and duration that produced it — or one named reason why nothing was read.
//
// Which of those two branches happens depends on the machine: this laptop has tesseract with the English pack,
// the macos-arm64 CI runner may not have it at all. Both are honest outcomes and the spec accepts either, but
// it prints the branch it actually got: a run that never reached the engine must not be read as evidence that
// recognition works.
//
// The printed page is rendered with cupsfilter + sips, both of which ship with macOS, exactly as
// src/main/settings/ocr-service.real.test.ts does — the fixture carries no committed binary. Where those
// programs are unavailable the spec falls back to a 1x1 PNG and says so; the run then exercises the honest
// "nothing to read" side rather than pretending the page was there.
const FALLBACK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const renderTextImage = (directory: string): { bytes: Buffer; rendered: boolean } => {
  const textPath = join(directory, 'page.txt')
  const pdfPath = join(directory, 'page.pdf')
  const pngPath = join(directory, 'page.png')
  writeFileSync(textPath, 'HEMOGLOBIN 12.4 g/dL\nPLATELETS 210 K/uL\n', 'utf8')
  try {
    // `encoding` is left at the default here only because the PDF is passed straight back to a file; the real
    // test pins it to 'buffer' because a UTF-8 decode mangles the PDF and sips then renders a blank page.
    const pdf = execFileSync('cupsfilter', ['-m', 'application/pdf', textPath], {
      maxBuffer: 8 * 1024 * 1024
    })
    writeFileSync(pdfPath, pdf)
    execFileSync('sips', ['-s', 'format', 'png', pdfPath, '--out', pngPath])
    return { bytes: readFileSync(pngPath), rendered: true }
  } catch (error) {
    console.log(`[ocr-cert] page render unavailable, falling back to a blank PNG: ${String(error)}`)
    return { bytes: FALLBACK_PNG, rendered: false }
  }
}

test.setTimeout(240_000)

test('reads text out of an uploaded image, or says by name why it cannot', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  // The composer only offers images to a model that says it takes them, and the fake agent's provider is
  // created without that flag. It is turned on here through the app's own settings channel: the attachment
  // path under test is unchanged, and what is being accepted is the reading of the image, not the model.
  await page.evaluate(async (providerName) => {
    const bridge = globalThis as unknown as {
      api: {
        settings: {
          getSettings: () => Promise<{ providers?: Array<{ id: string; name: string }> }>
          upsertProvider: (request: unknown) => Promise<{
            providers: Array<{ id: string; name: string; supportsImageInput?: boolean }>
          }>
        }
      }
    }
    const settings = await bridge.api.settings.getSettings()
    const existing = (settings.providers ?? []).find((provider) => provider.name === providerName)
    if (!existing) throw new Error('The fake agent provider is not in the settings view.')
    const snapshot = await bridge.api.settings.upsertProvider({
      id: existing.id,
      type: 'custom',
      name: providerName,
      supportsImageInput: true
    })
    const updated = snapshot.providers.find((provider) => provider.id === existing.id)
    if (updated?.supportsImageInput !== true) {
      throw new Error('The provider did not accept the image-input capability.')
    }
  }, 'Electron E2E provider')
  page = await app.restart()

  await createProject(page, 'Image text evidence')
  const workDirectory = await app.createTestDirectory('ocr-image')
  const image = renderTextImage(workDirectory)

  // Both files go in through the composer's own picker: one image (which the panel must offer to read) and one
  // note (which must not get the button at all). Uploads are finalised when the turn is sent, which is what
  // puts them in the project-files index.
  await page.locator('input[type="file"][multiple]').setInputFiles([
    { name: 'lab-scan.png', mimeType: 'image/png', buffer: image.bytes },
    {
      name: 'lab-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Notes\n\nplate 12\n')
    }
  ])
  await expect(page.getByRole('button', { name: 'Remove attachment lab-scan.png' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove attachment lab-notes.md' })).toBeVisible()
  await sendPrompt(page, 'Read the attached scan.', 'Deterministic reply:')

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByTestId('files-view')).toBeVisible()

  const ocrButton = page.getByRole('button', { name: 'Read text from lab-scan.png' })
  await expect(ocrButton).toBeVisible({ timeout: 60_000 })

  // An uploaded file is not a missing one: the tile must not carry the "Missing" badge, and the action must be
  // usable. These two used to be false for every upload, because the availability probe asked the artifact
  // resolver about a path that lives under the uploads root.
  //
  // The probe answers on its own timeline and the tile reads "available" until it does, so an assertion made
  // straight after the panel opens can pass and the click then dies as an opaque 30 s locator timeout — that is
  // how the macos-arm64 lane reported a tile that was badged a moment later. The DOM paints no "answered"
  // state, so this reads the tile after a settle window instead, and a badged tile fails here, by name.
  const missingBadge = page.getByText('Missing', { exact: true })
  const readTileAfterProbe = async (): Promise<'missing' | 'disabled' | 'ready'> => {
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      if ((await missingBadge.count()) > 0) return 'missing'
      if (attempt === 10) return (await ocrButton.isEnabled()) ? 'ready' : 'disabled'
      await page.waitForTimeout(200)
    }
    return 'disabled'
  }
  const tile = await readTileAfterProbe()
  console.log(`[ocr-cert] tile=${tile} before the read`)
  if (tile !== 'ready') {
    throw new Error(
      `[ocr-cert] the upload tile reads "${tile}": an uploaded file was probed as unavailable, which disables ` +
        'every action on it. The probe has to resolve uploads through the upload repository, not the artifact root.'
    )
  }
  await expect(missingBadge, 'an uploaded file must not be badged Missing').toHaveCount(0)
  await expect(ocrButton, 'the tile must let the reader read the image').toBeEnabled()

  // Reverse control: the note is on the same panel and gets no OCR button, and the panel holds exactly one —
  // so the button is a property of the image, not of the panel.
  await expect(
    page.getByRole('button', { name: 'Preview uploaded file lab-notes.md' })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Read text from lab-notes.md' })).toHaveCount(0)
  await expect(page.locator('[data-slot="file-ocr-action"]')).toHaveCount(1)

  await ocrButton.click()
  const dialog = page.locator('[data-slot="file-ocr-dialog"]')
  await expect(dialog).toBeVisible()

  // One key per rendered outcome, spelled exactly like the branch a run reports. The keys and the switch below
  // are the same literals on purpose: a name that only exists in one of the two places makes the run fall
  // through to the wrong assertion, and on this laptop that is invisible because the engine branch always wins
  // here — the lane that has no tesseract is the only one that ever sees it.
  const outcomeNodes = {
    text: dialog.getByTestId('file-ocr-text'),
    empty: dialog.getByTestId('file-ocr-empty'),
    'tool-missing': dialog.getByTestId('file-ocr-tool-missing'),
    'pack-missing': dialog.getByTestId('file-ocr-pack-missing'),
    unsupported: dialog.getByTestId('file-ocr-unsupported'),
    unreadable: dialog.getByTestId('file-ocr-unreadable')
  } satisfies Record<string, ReturnType<typeof dialog.getByTestId>>
  type OutcomeName = keyof typeof outcomeNodes

  // The panel must never be an empty box: exactly one of "here is the text" and the named failures is on
  // screen, counted as a positive condition rather than by waiting for the running line to disappear.
  const visibleOutcomes = async (): Promise<OutcomeName[]> => {
    const seen: OutcomeName[] = []
    for (const name of Object.keys(outcomeNodes) as OutcomeName[]) {
      if (await outcomeNodes[name].isVisible()) seen.push(name)
    }
    return seen
  }
  await expect.poll(async () => (await visibleOutcomes()).length, { timeout: 180_000 }).toBe(1)

  const [branch] = await visibleOutcomes()
  const bodyText = await dialog.innerText()
  console.log(
    `[ocr-cert] rendered=${image.rendered} branch=${branch} dialog="${bodyText.replace(/\s+/g, ' ').slice(0, 240)}"`
  )

  switch (branch) {
    case 'text': {
      const recognised = (await outcomeNodes.text.innerText()).trim()
      const provenance = await dialog.getByTestId('file-ocr-provenance').innerText()
      console.log(`[ocr-cert] provenance="${provenance}"`)
      expect(recognised.length).toBeGreaterThan(0)
      // The sentence that says where the text came from names the pack, the engine and how long it took.
      expect(provenance).toContain('eng.traineddata')
      expect(provenance).toContain('tesseract eng')
      expect(provenance).toMatch(/\d+ ms/)
      expect(provenance).toContain('came from an image')
      if (image.rendered) {
        // The engine's own reading of the page the fixture printed: the numbers matter more than the words.
        expect(recognised.toUpperCase()).toContain('HEMOGLOBIN')
        expect(recognised.toUpperCase()).toContain('12.4')
      }
      break
    }
    case 'tool-missing':
      await expect(outcomeNodes['tool-missing']).toContainText('needs the tesseract program')
      break
    case 'pack-missing':
      await expect(outcomeNodes['pack-missing']).toContainText('language pack')
      if (image.rendered) {
        await expect(outcomeNodes['pack-missing']).toContainText('eng.traineddata')
      }
      break
    case 'unsupported':
      await expect(outcomeNodes.unsupported).toContainText('has no OCR language pack')
      break
    case 'unreadable':
      await expect(outcomeNodes.unreadable).toContainText('could not be read')
      break
    case 'empty':
      await expect(outcomeNodes.empty).toContainText('recognised no characters')
      break
    default: {
      // Exhaustiveness, checked by the compiler: a new outcome that is never asserted here cannot be added
      // without this line failing to typecheck.
      const unexpected: never = branch
      throw new Error(`[ocr-cert] unhandled outcome ${String(unexpected)}`)
    }
  }

  // The panel is opened from page state and renders no Dialog.Trigger, so the control that started the read is
  // the only thing that can take focus back. Without the hook focus lands on <body> and a keyboard reader is
  // dropped at the top of the document.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect
    .poll(async () =>
      page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? ''
      )
    )
    .toBe('Read text from lab-scan.png')
})
