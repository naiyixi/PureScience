import { describe, expect, it, vi } from 'vitest'

import { OcrService, type OcrRun } from './ocr-service'

const LANGS_OUTPUT = `List of available languages in "/opt/homebrew/share/tessdata/" (2):
eng
osd`

const runner = (
  handler: (file: string, args: readonly string[]) => { stdout: string; stderr?: string } | Error
): OcrRun =>
  vi.fn(async (file, args) => {
    const result = handler(file, args)
    if (result instanceof Error) throw result
    return { stdout: result.stdout, stderr: result.stderr ?? '' }
  })

describe('OcrService', () => {
  it('recognises with the pack that serves the UI language, and strips the page form feed', async () => {
    const run = runner((_file, args) => {
      if (args[0] === '--list-langs') return { stdout: LANGS_OUTPUT }
      return { stdout: 'HEMOGLOBIN 12.4 g/dL\n\nPLATELETS 210 K/uL\n\f' }
    })
    const service = new OcrService({ run, now: () => 1_000 })

    const result = await service.recognise('/tmp/lab.png', 'en')

    expect(result).toMatchObject({
      status: 'recognised',
      language: 'eng',
      text: 'HEMOGLOBIN 12.4 g/dL\n\nPLATELETS 210 K/uL'
    })
    // The file is handed to tesseract as an argument, never through a shell.
    expect(run).toHaveBeenLastCalledWith('tesseract', ['/tmp/lab.png', 'stdout', '-l', 'eng'])
  })

  it('refuses a language whose pack is missing, and names the pack and what is installed', async () => {
    const run = runner((_file, args) => {
      if (args[0] === '--list-langs') return { stdout: LANGS_OUTPUT }
      throw new Error('must not recognise')
    })
    const service = new OcrService({ run })

    expect(await service.recognise('/tmp/scan.png', 'zh')).toEqual({
      status: 'pack-missing',
      language: 'chi_sim',
      packFile: 'chi_sim.traineddata',
      // Only the packs this product can use are reported; tesseract's own "osd" is not a language.
      installed: ['eng']
    })
    // Never recognised in another language: the reader is not shown English noise as Chinese text.
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports a missing tesseract as a missing tool, not as an empty document', async () => {
    const run = runner(() => new Error('spawn tesseract ENOENT'))
    const service = new OcrService({ run })

    expect(await service.recognise('/tmp/scan.png', 'en')).toEqual({ status: 'tool-missing' })
  })

  it('maps a traditional-Chinese UI to chi_tra rather than chi_sim', async () => {
    const run = runner((_file, args) => {
      if (args[0] === '--list-langs') return { stdout: LANGS_OUTPUT }
      throw new Error('must not recognise')
    })
    const service = new OcrService({ run })

    expect(await service.recognise('/tmp/scan.png', 'zh-Hant')).toMatchObject({
      status: 'pack-missing',
      language: 'chi_tra'
    })
  })

  it('refuses a UI language it has no pack for instead of falling back to English', async () => {
    const service = new OcrService({ run: runner(() => ({ stdout: LANGS_OUTPUT })) })

    expect(await service.recognise('/tmp/scan.png', 'pt')).toEqual({
      status: 'unsupported-language',
      uiLanguage: 'pt'
    })
  })

  it('reports an engine failure with its message, so a corrupt image is not reported as no text', async () => {
    const run = runner((_file, args) => {
      if (args[0] === '--list-langs') return { stdout: LANGS_OUTPUT }
      throw new Error('Error, cannot read input file /tmp/scan.png')
    })
    const service = new OcrService({ run })

    expect(await service.recognise('/tmp/scan.png', 'en')).toEqual({
      status: 'unreadable',
      message: 'Error, cannot read input file /tmp/scan.png'
    })
  })

  it('caches the pack list instead of spawning tesseract before every page', async () => {
    let clock = 0
    const run = runner((_file, args) => {
      if (args[0] === '--list-langs') return { stdout: LANGS_OUTPUT }
      return { stdout: 'text\n\f' }
    })
    const service = new OcrService({ run, now: () => clock })

    await service.recognise('/tmp/a.png', 'en')
    await service.recognise('/tmp/b.png', 'en')
    const listCalls = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (call) => Array.isArray(call[1]) && (call[1] as string[])[0] === '--list-langs'
    )
    expect(listCalls).toHaveLength(1)

    // Past the TTL the pack list is asked for again: a pack installed while the app runs becomes usable.
    clock = 61_000
    await service.recognise('/tmp/c.png', 'en')
    const afterExpiry = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (call) => Array.isArray(call[1]) && (call[1] as string[])[0] === '--list-langs'
    )
    expect(afterExpiry).toHaveLength(2)
  })
})
