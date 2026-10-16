// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => {
  // The factory runs once, so `t` keeps one identity across renders — the real provider memoizes it, and
  // a fresh function per render would re-run every effect that lists `t` in its dependencies.
  const labels: Record<string, string> = {
    'settings.localParsingModels': 'Local parsing models',
    'settings.localParsingModelsHint':
      'Models that run on this machine to parse documents and figures.',
    'settings.localParsingModelsIntro': 'The manifest ships with the app; the weights do not.',
    'settings.localParsingModelsNotParsingYet': 'Fetching a model here does not make it parse yet.',
    'settings.localParsingModelsLoading': 'Reading the manifest…',
    'settings.localParsingModelsUnavailable':
      'Local parsing models are unavailable in this window.',
    'settings.localParsingModelsLoadFailed': 'Could not read the local parsing models.',
    'settings.localParsingModelsAbsent': 'This build carries no manifest for local parsing models.',
    'settings.localParsingModelsInvalid': 'The manifest in this build does not validate:',
    'settings.localParsingModelsEmpty': 'The manifest is valid and lists no models.',
    'settings.localParsingModelsInstalled': 'On this machine',
    'settings.localParsingModelsMissing': 'Not on this machine',
    'settings.localParsingModelsPublisherMd5Label': 'the publisher checksum',
    'settings.localParsingModelsConsent': 'I understand this downloads {size} over the internet.',
    'settings.localParsingModelsDownload': 'Download and verify',
    'settings.localParsingModelsDownloading': 'Downloading…'
  }
  const t = (key: string, vars?: Record<string, string | number>): string =>
    (labels[key] ?? key).replace('{size}', String(vars?.size ?? ''))
  return { useLanguage: () => ({ t }) }
})

const { LocalParsingModelsSection } = await import('./LocalParsingModelsSection')

const MODEL = {
  id: 'structure-recognition-primary',
  revision: 'zenodo-10.5281/zenodo.8300489',
  publisher: 'PureScience',
  bytes: 298662033,
  license: 'CC-BY-4.0',
  kind: 'structure-recognition',
  sha256: '8ebc7db18fffac7e71a2cf8487708053620d124846bc9502eddac1283b431d2b',
  publisherMd5: 'de78c966b0d63b290cd3f70bb81a91e7',
  installed: false
}

const usable = (installed: boolean): unknown => ({
  report: { source: 'packaged', present: true, state: 'usable', entryCount: 1, problems: [] },
  models: [{ ...MODEL, installed }]
})

type Api = {
  getLocalParsingModels?: () => Promise<unknown>
  downloadLocalParsingModel?: (request: { id: string; consent: boolean }) => Promise<unknown>
}

const mockApi = (settings: Api): void => {
  ;(window as unknown as { api: unknown }).api = { settings }
}

describe('LocalParsingModelsSection', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (): Promise<void> =>
    act(async () => {
      root.render(<LocalParsingModelsSection />)
    })

  const byTestId = <T extends Element>(id: string): T | null =>
    container.querySelector<T>(`[data-testid="${id}"]`)

  it('lists the published facts, and only sends a download from a box the reader ticked', async () => {
    const download = vi.fn(async (request: { id: string; consent: boolean }) => ({
      status: 'downloaded',
      modelId: request.id,
      verifiedSha256: MODEL.sha256,
      message: '已下载并校验通过，可在本机离线使用。'
    }))
    const list = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(usable(false))
      .mockResolvedValue(usable(true))
    mockApi({ getLocalParsingModels: list, downloadLocalParsingModel: download })

    await render()

    const row = container.querySelector('[data-slot="local-parsing-model-row"]')
    expect(row?.getAttribute('data-model-installed')).toBe('false')
    // The facts a reader can check against the manifest themselves.
    expect(container.textContent).toContain(MODEL.revision)
    expect(container.textContent).toContain('CC-BY-4.0')
    expect(container.textContent).toContain('299 MB')
    expect(container.textContent).toContain('sha256 8ebc7db18fff…')
    expect(container.textContent).toContain('de78c966b0d63b290cd3f70bb81a91e7')
    // The section says what fetching does NOT do yet, so a badge cannot be read as "parsing works now".
    expect(container.textContent).toContain('does not make it parse yet')

    const button = byTestId<HTMLButtonElement>(`local-parsing-download-${MODEL.id}`)
    const consent = byTestId<HTMLInputElement>(`local-parsing-consent-${MODEL.id}`)
    expect(button?.disabled).toBe(true)

    await act(async () => {
      consent?.click()
    })
    expect(button?.disabled).toBe(false)

    await act(async () => {
      button?.click()
    })

    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]?.[0]).toEqual({ id: MODEL.id, consent: true })
    // The refusal/success sentence is the main process's own, shown verbatim.
    expect(byTestId('local-parsing-outcome-' + MODEL.id)?.textContent).toContain(
      '已下载并校验通过，可在本机离线使用。'
    )
    // The list is re-read, so what is on screen after the fetch is a fresh reading, not a guess.
    expect(list).toHaveBeenCalledTimes(2)
    expect(
      container
        .querySelector('[data-slot="local-parsing-model-row"]')
        ?.getAttribute('data-model-installed')
    ).toBe('true')
    // Re-queried, not the reference captured before the re-render: what matters is what is on screen now.
    expect(byTestId(`local-parsing-download-${MODEL.id}`)).toBeNull()
  })

  it('names an unusable manifest problem by problem and offers no button at all', async () => {
    mockApi({
      getLocalParsingModels: async () => ({
        report: {
          source: 'packaged',
          present: true,
          state: 'invalid',
          reason: 'failed-validation',
          problems: [{ index: 0, field: 'url', message: 'url must be https' }]
        },
        models: []
      })
    })

    await render()

    expect(container.textContent).toContain('does not validate:')
    expect(container.querySelector('[data-slot="local-parsing-model-problem"]')?.textContent).toBe(
      '#0 url: url must be https'
    )
    expect(container.querySelector('button')).toBeNull()
  })

  it('says which kind of absence it is instead of showing an empty list', async () => {
    mockApi({
      getLocalParsingModels: async () => ({
        report: { source: 'none', present: false, state: 'absent', problems: [] },
        models: []
      })
    })

    await render()

    expect(container.textContent).toContain('carries no manifest for local parsing models')
    expect(container.querySelector('button')).toBeNull()
  })

  it('does not render a control where the window has no bridge for it', async () => {
    mockApi({})

    await render()

    expect(container.textContent).toContain('unavailable in this window')
    expect(container.querySelector('button')).toBeNull()
  })
})
