import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OcrService } from './ocr-service'

const execFileAsync = promisify(execFile)

// The unit tests above inject a runner, so they prove the branch logic and nothing about the engine. This file
// runs the real tesseract on a real image, and is skipped wherever that engine is not installed (CI runners,
// Windows) instead of being faked.
const TESSERACT = [
  '/opt/homebrew/bin/tesseract',
  '/usr/local/bin/tesseract',
  '/usr/bin/tesseract'
].find((candidate) => existsSync(candidate))
const CAN_RENDER_TEXT = process.platform === 'darwin'

const renderTextPng = async (directory: string): Promise<string> => {
  const textPath = path.join(directory, 'page.txt')
  const pdfPath = path.join(directory, 'page.pdf')
  const pngPath = path.join(directory, 'page.png')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(textPath, 'HEMOGLOBIN 12.4 g/dL\nPLATELETS 210 K/uL\n', 'utf8')
  // cupsfilter renders text to a PDF and sips rasterises it: both ship with macOS, so the fixture needs no
  // committed binary.
  // `encoding: 'buffer'` matters: the default UTF-8 decode mangles the PDF and sips then renders a blank page,
  // which OCR reads as an empty document rather than an error.
  const pdf = await execFileAsync('cupsfilter', ['-m', 'application/pdf', textPath], {
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'buffer'
  } as { maxBuffer: number; encoding: 'buffer' })
  await writeFile(pdfPath, pdf.stdout)
  await execFileAsync('sips', ['-s', 'format', 'png', pdfPath, '--out', pngPath])
  return pngPath
}

describe.skipIf(!TESSERACT || !CAN_RENDER_TEXT)('OcrService against the real engine', () => {
  let directory: string
  let pngPath: string

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ocr-real-'))
    pngPath = await renderTextPng(directory)
  })

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('reads a rendered page with the installed English pack', async () => {
    const service = new OcrService()
    const result = await service.recognise(pngPath, 'en')

    if (result.status !== 'recognised') throw new Error(`expected recognised, got ${result.status}`)
    expect(result.language).toBe('eng')
    // The engine's own output, not a paraphrase: the numbers matter more than the words.
    expect(result.text).toContain('HEMOGLOBIN 12.4')
    expect(result.text).toContain('PLATELETS 210')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  }, 60_000)

  it('reports the missing Chinese pack on a machine that only has English', async () => {
    const service = new OcrService()
    const installed = await service.installedLanguages()
    if (installed?.includes('chi_sim')) return

    expect(await service.recognise(pngPath, 'zh')).toMatchObject({
      status: 'pack-missing',
      language: 'chi_sim'
    })
  }, 60_000)
})
