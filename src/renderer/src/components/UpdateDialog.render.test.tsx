// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LanguageProvider, type Language } from '@/i18n'
import { useUpdateStore } from '@/stores/update-store'
import { UpdateDialog } from './UpdateDialog'
import { APP } from '../../../shared/app-config'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.localStorage.clear()
  useUpdateStore.setState({ isDialogOpen: false, status: { state: 'idle', current: '' } })
})

// The renderer copy is asserted in the default (English) language; the language-specific cases mount a
// fresh provider so the dictionary under test is the one that renders.
const renderDialog = (language?: Language): void => {
  if (language) {
    act(() => root.unmount())
    root = createRoot(container)
    window.localStorage.setItem('purescience-language', language)
    act(() => {
      root.render(
        <LanguageProvider>
          <UpdateDialog />
        </LanguageProvider>
      )
    })
    return
  }
  act(() => root.render(<UpdateDialog />))
}

describe('UpdateDialog', () => {
  it('uses shared settings dialog chrome and prevents outside-click dismissal', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0' }
    })
    act(() => root.render(<UpdateDialog />))

    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    const source = readFileSync(resolve(__dirname, 'UpdateDialog.tsx'), 'utf8')

    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(overlay?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(source).toContain('dialogOverlayClassName')
    expect(source).toContain('dialogPanelClassName')
    expect(source).toContain('onInteractOutside={(event) => event.preventDefault()}')
  })

  it('renders nothing when the dialog is closed', () => {
    useUpdateStore.setState({
      isDialogOpen: false,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).not.toContain('Update available')
  })

  it('shows the current/new version and release notes when present', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0', notes: 'Shiny new things' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('v0.1.0')
    expect(document.body.textContent).toContain('v0.2.0')
    expect(document.body.textContent).toContain('Shiny new things')
  })

  it('links to the matching GitHub release when notes are missing', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0' }
    })
    act(() => root.render(<UpdateDialog />))
    const link = document.body.querySelector('a[href*="/releases/tag/v0.2.0"]')
    expect(link).not.toBeNull()
  })

  it('invokes download when the download button is clicked', () => {
    const download = vi.fn()
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0' },
      download
    })
    act(() => root.render(<UpdateDialog />))
    const button = Array.from(document.body.querySelectorAll('button')).find((element) =>
      /download update/i.test(element.textContent ?? '')
    )
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(download).toHaveBeenCalled()
  })

  it('shows "Restart to update" when a ready update applies in place (win/linux)', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'ready', current: '0.1.0', latest: '0.2.0', applyKind: 'restart' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('Restart to update')
    expect(document.body.textContent).not.toContain('Open installer')
    // U2: the downloaded state names the action that finishes the install — it used to read as advice
    // to go restart the app by hand ("restart PureScience to finish installing").
    expect(document.body.textContent).toContain(
      'click “Restart to update” to quit PureScience and finish installing'
    )
  })

  it('quits and installs from the one click the ready state asks for', () => {
    const apply = vi.fn()
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'ready', current: '0.1.0', latest: '0.2.0', applyKind: 'restart' },
      apply
    })
    act(() => root.render(<UpdateDialog />))

    const button = Array.from(document.body.querySelectorAll('button')).find((element) =>
      /restart to update/i.test(element.textContent ?? '')
    )
    expect(button).toBeDefined()
    act(() => button?.click())

    // The whole point of U2: one click hands off to the installer (the app quits itself) — the user is
    // never asked to end the process by hand.
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('points a ready installer-kind update at the downloaded package (macOS)', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'ready', current: '0.1.0', latest: '0.2.0', applyKind: 'installer' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('Open installer')
    expect(document.body.textContent).toContain('click “Open installer” to finish updating')
    expect(document.body.textContent).not.toContain('Restart to update')
  })

  it('explains the install wait and locks actions while applying', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'applying', current: '0.1.0', latest: '0.2.0', applyKind: 'restart' }
    })
    act(() => root.render(<UpdateDialog />))

    expect(document.body.textContent).toContain('Preparing update…')
    expect(document.body.textContent).toContain('update may take a moment')
    expect(document.body.textContent).toContain('please don’t reopen the app')
    expect(
      Array.from(document.body.querySelectorAll('button')).every((button) => button.disabled)
    ).toBe(true)
  })

  it('shows "Open installer" when a ready update applies via installer (mac)', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'ready', current: '0.1.0', latest: '0.2.0', applyKind: 'installer' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('Open installer')
    expect(document.body.textContent).not.toContain('Restart to update')
  })

  it('offers a manual download fallback when the update errors', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'error', current: '0.1.0', latest: '0.2.0', error: 'Install failed' }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('Install failed')
    const link = document.body.querySelector(`a[href="${APP.update.downloadPage}"]`)
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain('Download manually')
  })

  it('shows download size on the download button when totalBytes is present', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'available',
        current: '0.1.0',
        latest: '0.2.0',
        totalBytes: 12.5 * 1024 * 1024
      }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('Download update (12.5 MB)')
  })

  it('shows the size the updater reported and formats it for the interface language', () => {
    // R2: the number on the button is the updater's own report for this platform's artifact — the
    // decimal separator follows the interface language and nothing else changes.
    const reported = 12.5 * 1024 * 1024
    useUpdateStore.setState({
      isDialogOpen: true,
      status: { state: 'available', current: '0.1.0', latest: '0.2.0', totalBytes: reported }
    })
    renderDialog('de')
    expect(document.body.textContent).toContain('Update herunterladen (12,5 MB)')

    act(() =>
      useUpdateStore.setState({
        status: { state: 'available', current: '0.1.0', latest: '0.2.0', totalBytes: reported }
      })
    )
    renderDialog('zh')
    expect(document.body.textContent).toContain('下载更新（12.5 MB）')

    act(() =>
      useUpdateStore.setState({
        status: { state: 'available', current: '0.1.0', latest: '0.2.0', totalBytes: reported }
      })
    )
    renderDialog('ru')
    expect(document.body.textContent).toContain('Скачать обновление (12,5 MB)')
  })

  it('never shows a size the updater did not report', () => {
    // R2: no estimate, no placeholder, no zero — an unknown total leaves the plain action label.
    for (const totalBytes of [undefined, 0, Number.NaN]) {
      act(() =>
        useUpdateStore.setState({
          isDialogOpen: true,
          status: { state: 'available', current: '0.1.0', latest: '0.2.0', totalBytes }
        })
      )
      renderDialog()
      const button = Array.from(document.body.querySelectorAll('button')).find((element) =>
        /download update/i.test(element.textContent ?? '')
      )
      expect(button?.textContent).toBe('Download update')
      expect(document.body.textContent).not.toContain('MB')
    }
  })

  it('renders the release notes as group titles, numbered entries and entry subtitles', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'available',
        current: '0.1.0',
        latest: '0.2.0',
        notes: [
          '## 修复',
          '- **下载体积**：按钮上显示更新器报出的真实体积',
          '- 保留条目里的改动引用 5ef94da',
          '',
          '> 渲染不了的语法原样显示'
        ].join('\n')
      }
    })
    renderDialog('zh')

    const groups = document.body.querySelectorAll('[data-testid="release-note-group"]')
    expect(groups).toHaveLength(1)
    expect(
      document.body.querySelector('[data-testid="release-note-group-title"]')?.textContent
    ).toBe('修复')
    expect(document.body.querySelectorAll('[data-testid="release-note-entry"]')).toHaveLength(2)
    expect(
      document.body.querySelector('[data-testid="release-note-entry-title"]')?.textContent
    ).toBe('下载体积：')
    expect(document.body.textContent).toContain('5ef94da')
    expect(document.body.textContent).toContain('> 渲染不了的语法原样显示')
  })

  it('shows downloaded and total bytes alongside the progress bar while downloading', () => {
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'downloading',
        current: '0.1.0',
        latest: '0.2.0',
        progress: 42,
        downloadedBytes: 4200,
        totalBytes: 10000
      }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('4.1 KB')
    expect(document.body.textContent).toContain('9.8 KB')
    expect(document.body.textContent).toContain('42%')
  })

  it('renders the download line without a percent when total is unknown', () => {
    // No downloadProgress yet and unknown total: the shared line shows bytes downloaded, no percent,
    // rather than a misleading fixed percentage against an unknown total.
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'downloading',
        current: '0.1.0',
        latest: '0.2.0',
        progress: 35,
        downloadedBytes: undefined,
        totalBytes: undefined
      }
    })
    act(() => root.render(<UpdateDialog />))
    // Scope the percent check to the download line itself (the last .tabular-nums; the first is the
    // version subtitle). The download button label separately shows "Downloading 35%".
    const lines = document.body.querySelectorAll('.tabular-nums')
    const line = lines[lines.length - 1]
    expect(line?.textContent).toContain('downloaded')
    expect(line?.textContent).not.toContain('%')
  })

  it('mirrors the full download detail (speed) from downloadProgress while downloading', () => {
    // Once a progress broadcast arrives, the store carries the superset detail and the dialog shows
    // the speed line from the shared DownloadProgressLine.
    useUpdateStore.setState({
      isDialogOpen: true,
      status: {
        state: 'downloading',
        current: '0.1.0',
        latest: '0.2.0',
        progress: 42,
        downloadedBytes: 4200,
        totalBytes: 10000,
        downloadProgress: {
          phase: 'downloading',
          transferred: 4200,
          total: 10000,
          percent: 42,
          bytesPerSecond: 2_411_724,
          attempt: 0
        }
      }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('2.3 MB/s')
    expect(document.body.textContent).toContain('42%')
  })
})
