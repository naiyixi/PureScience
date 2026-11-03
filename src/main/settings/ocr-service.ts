import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  ocrLanguageForUi,
  parseTesseractLanguages,
  type OcrLanguageCode,
  type OcrRecogniseOutcome
} from '../../shared/ocr'
import { createLogger } from '../logger'
import { augmentedPathEnv } from './shell-path'

const execFileAsync = promisify(execFile)

const log = createLogger('ocr')

// A GUI-launched app inherits a PATH that often lacks /opt/homebrew/bin, which is exactly where a Homebrew
// tesseract lives; the same augmented PATH the agent adapters use is used here.
const RUN_TIMEOUT_MS = 120_000
const MAX_BUFFER = 32 * 1024 * 1024
const LANGUAGE_CACHE_MS = 60_000

export type OcrRun = (
  file: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>

// The outcome union lives in shared/ocr.ts: the window renders it, so it is not a main-process-only shape.
export type OcrRecogniseResult = OcrRecogniseOutcome

export type OcrServiceDeps = {
  run?: OcrRun
  now?: () => number
}

export class OcrService {
  private readonly run: OcrRun
  private readonly now: () => number
  private languageCache: { at: number; languages: OcrLanguageCode[] } | null = null

  constructor(deps: OcrServiceDeps = {}) {
    this.run =
      deps.run ??
      (async (file, args) => {
        const { stdout, stderr } = await execFileAsync(file, [...args], {
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          env: augmentedPathEnv(process.env)
        })
        return { stdout, stderr }
      })
    this.now = deps.now ?? Date.now
  }

  async installedLanguages(): Promise<OcrLanguageCode[] | null> {
    const cached = this.languageCache
    if (cached && this.now() - cached.at < LANGUAGE_CACHE_MS) return cached.languages
    let stdout: string
    try {
      stdout = (await this.run('tesseract', ['--list-langs'])).stdout
    } catch (error) {
      // ENOENT is "no tesseract"; anything else is also "cannot use OCR", and both are reported the same way to
      // the caller so a missing tool never looks like a document with no text.
      log.warn('tesseract --list-langs failed', { error: String(error) })
      return null
    }
    const languages = parseTesseractLanguages(stdout)
    this.languageCache = { at: this.now(), languages }
    return languages
  }

  async recognise(path: string, uiLanguage: string): Promise<OcrRecogniseResult> {
    const language = ocrLanguageForUi(uiLanguage)
    if (!language) return { status: 'unsupported-language', uiLanguage }

    const installed = await this.installedLanguages()
    if (installed === null) return { status: 'tool-missing' }
    if (!installed.includes(language.code)) {
      return {
        status: 'pack-missing',
        language: language.code,
        packFile: language.packFile,
        installed
      }
    }

    const startedAt = this.now()
    try {
      const { stdout } = await this.run('tesseract', [path, 'stdout', '-l', language.code])
      return {
        status: 'recognised',
        // Tesseract ends every page with a form feed; a blank line is kept because it is a paragraph break.
        text: stdout
          .replace(/\f+$/g, '')
          .replace(/[ \t]+$/gm, '')
          .trim(),
        language: language.code,
        packFile: language.packFile,
        durationMs: this.now() - startedAt
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('tesseract recognise failed', { path, language: language.code, error: message })
      return { status: 'unreadable', message }
    }
  }
}
