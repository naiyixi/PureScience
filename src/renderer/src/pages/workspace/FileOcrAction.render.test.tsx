// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LanguageProvider } from '@/i18n'
import { FileOcrAction } from './FileOcrAction'
import { isImageFileName } from './file-ocr-name'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

const mount = async (options: {
  name?: string
  ocr?: ReturnType<typeof vi.fn>
  lang?: string
}): Promise<void> => {
  ;(window as unknown as { api: unknown }).api = {
    pdf: { ocr: options.ocr ?? vi.fn().mockResolvedValue({ status: 'tool-missing' }) }
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <LanguageProvider>
        <FileOcrAction
          source="artifact"
          path="/data/gel.png"
          name={options.name ?? 'gel.png'}
          projectId="project-1"
          sessionId="session-1"
          disabled={false}
          className=""
        />
      </LanguageProvider>
    )
  })
}

const click = async (): Promise<void> => {
  const button = document.querySelector<HTMLButtonElement>('[data-slot="file-ocr-action"]')
  expect(button).not.toBeNull()
  await act(async () => {
    button?.click()
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
})

describe('FileOcrAction', () => {
  it('only offers itself for images', async () => {
    expect(isImageFileName('gel.png')).toBe(true)
    expect(isImageFileName('scan.JPEG')).toBe(true)
    expect(isImageFileName('paper.pdf')).toBe(false)

    await mount({ name: 'paper.pdf' })
    expect(container?.querySelector('[data-slot="file-ocr-action"]')).toBeNull()
  })

  it('sends the file by source and path, and shows the text with the pack that read it', async () => {
    const ocr = vi.fn().mockResolvedValue({
      status: 'recognised',
      text: 'HEMOGLOBIN 12.4 g/dL',
      language: 'eng',
      packFile: 'eng.traineddata',
      durationMs: 412
    })
    await mount({ ocr })
    await click()

    expect(ocr).toHaveBeenCalledWith({
      source: 'artifact',
      path: '/data/gel.png',
      projectId: 'project-1',
      sessionId: 'session-1',
      uiLanguage: 'en'
    })
    expect(document.querySelector('[data-testid="file-ocr-text"]')?.textContent).toContain(
      'HEMOGLOBIN 12.4'
    )
    // The provenance line is the claim that this text is not the PDF text layer.
    expect(document.querySelector('[data-testid="file-ocr-provenance"]')?.textContent).toContain(
      'eng.traineddata'
    )
  })

  it('says which pack is missing instead of showing an empty result', async () => {
    await mount({
      ocr: vi.fn().mockResolvedValue({
        status: 'pack-missing',
        language: 'chi_sim',
        packFile: 'chi_sim.traineddata',
        installed: ['eng']
      })
    })
    await click()

    const message = document.querySelector('[data-testid="file-ocr-pack-missing"]')
    expect(message?.textContent).toContain('chi_sim.traineddata')
    expect(message?.textContent).toContain('eng')
    expect(document.querySelector('[data-testid="file-ocr-text"]')).toBeNull()
  })

  it('reports a missing engine rather than an unreadable image', async () => {
    await mount({ ocr: vi.fn().mockResolvedValue({ status: 'tool-missing' }) })
    await click()

    expect(document.querySelector('[data-testid="file-ocr-tool-missing"]')).not.toBeNull()
  })

  it('reports an engine failure with its own message', async () => {
    await mount({
      ocr: vi.fn().mockResolvedValue({
        status: 'unreadable',
        message: 'Error, cannot read input file'
      })
    })
    await click()

    expect(document.querySelector('[data-testid="file-ocr-unreadable"]')?.textContent).toContain(
      'Error, cannot read input file'
    )
  })
})
