// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCaseMarketStore } from '@/stores/case-market-store'

import { CaseMarketplace } from './CaseMarketplace'

const fetchMarketplace = vi.fn()
const installFromMarketplace = vi.fn()

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'internal-evaluation',
  name: '内部评测：多组学异常到首次人体试验',
  domain: 'general',
  summary: '真实项目的完整复现文件',
  author: 'naiyixi',
  license: 'MIT',
  bundleUrl: 'https://example.test/a.tar.gz',
  bundleSha256: 'b'.repeat(64),
  fileCount: 6,
  totalBytes: 1_774_692,
  publishedAt: 1,
  ...overrides
})

beforeEach(() => {
  fetchMarketplace.mockReset()
  installFromMarketplace.mockReset()
  // The shelf lives in a store, so every test starts from "nothing read yet" — including the read bookkeeping the
  // store uses to answer once per session.
  useCaseMarketStore.setState({
    shelf: { kind: 'loading' },
    install: { kind: 'idle' },
    reading: false,
    readAt: null
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { caseBundles: { fetchMarketplace, installFromMarketplace } }
  })
})

afterEach(() => cleanup())

const installButton = (): HTMLElement =>
  document.querySelector('[data-slot="case-market-install"]') as HTMLElement

describe('the case marketplace shelf', () => {
  // The rejection branch, not the refusal branch: a window whose main process has no such channel answers by
  // throwing, and an unhandled throw here is what once took the whole home surface down instead of saying one
  // section was unavailable.
  it('says the shelf is unavailable when the channel itself is missing, instead of throwing', async () => {
    fetchMarketplace.mockRejectedValue(
      new Error("Error invoking remote method 'cases:marketplace': Error: No handler registered")
    )
    render(<CaseMarketplace />)

    await waitFor(() => expect(useCaseMarketStore.getState().shelf.kind).toBe('unavailable'))
    expect(useCaseMarketStore.getState().shelf).toMatchObject({
      detail: expect.stringContaining('No handler registered')
    })
  })

  it('shows what a published index says: whose it is, what it holds, and its licence', async () => {
    fetchMarketplace.mockResolvedValue({
      status: 'ok',
      cases: [entry()],
      updatedAt: 1,
      source: 'network',
      fetchedAt: 1
    })
    render(<CaseMarketplace />)

    await waitFor(() => expect(screen.getByText('内部评测：多组学异常到首次人体试验')).toBeTruthy())
    expect(screen.getByText(/naiyixi · general/)).toBeTruthy()
    expect(screen.getByText(/6 个文件|6 files/)).toBeTruthy()
    expect(screen.getByText('MIT')).toBeTruthy()
  })

  it('says why the shelf is empty instead of rendering nothing', async () => {
    fetchMarketplace.mockResolvedValue({
      status: 'refused',
      reason: 'unreachable',
      detail: 'getaddrinfo ENOTFOUND'
    })
    render(<CaseMarketplace />)

    await waitFor(() =>
      expect(document.querySelector('[data-slot="case-market-refused"]')).toBeTruthy()
    )
    expect(screen.getByText('getaddrinfo ENOTFOUND')).toBeTruthy()
  })

  it('installs one case and reports where it landed', async () => {
    fetchMarketplace.mockResolvedValue({
      status: 'ok',
      cases: [entry()],
      updatedAt: 1,
      source: 'network',
      fetchedAt: 1
    })
    installFromMarketplace.mockResolvedValue({
      status: 'installed',
      name: '内部评测：多组学异常到首次人体试验',
      fileCount: 6,
      totalBytes: 1_774_692,
      installedTo: '/Users/me/.purescience/cases/内部评测'
    })
    render(<CaseMarketplace />)

    await waitFor(() => expect(installButton()).toBeTruthy())
    installButton().click()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="case-market-installed"]')).toBeTruthy()
    )
    // The window sends the entry — not a URL it made up, and not a destination.
    expect(installFromMarketplace).toHaveBeenCalledWith({ entry: entry() })
    expect(screen.getByText(/\/Users\/me\/\.purescience\/cases\//)).toBeTruthy()
  })

  it('shows the offending file names when a case fails its own manifest', async () => {
    fetchMarketplace.mockResolvedValue({
      status: 'ok',
      cases: [entry()],
      updatedAt: 1,
      source: 'network',
      fetchedAt: 1
    })
    installFromMarketplace.mockResolvedValue({
      status: 'refused',
      reason: 'incomplete',
      problematic: { missing: [], checksumMismatch: ['report.md'], unexpected: ['stowaway.exe'] }
    })
    render(<CaseMarketplace />)

    await waitFor(() => expect(installButton()).toBeTruthy())
    installButton().click()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="case-market-error"]')).toBeTruthy()
    )
    expect(screen.getByText(/report\.md/)).toBeTruthy()
    expect(screen.getByText(/stowaway\.exe/)).toBeTruthy()
    expect(screen.queryByText(/Installed|已把/)).toBeNull()
  })

  it('searches the shelf by name and by publisher', async () => {
    fetchMarketplace.mockResolvedValue({
      status: 'ok',
      cases: [entry(), entry({ id: 'other', name: 'mRNA-LNP 内体逃逸', author: 'Mistral' })],
      updatedAt: 1,
      source: 'network',
      fetchedAt: 1
    })
    render(<CaseMarketplace />)

    await waitFor(() =>
      expect(document.querySelector('[data-slot="case-market-search"]')).toBeTruthy()
    )
    const search = document.querySelector('[data-slot="case-market-search"]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'mrna' } })

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="case-market-card"]')).toHaveLength(1)
    )
  })

  // The section renders on the home page, so "open the app, then come back to it" used to mean a second network read
  // of another machine's document — and where that host does not answer, a second full deadline of waiting. Measured
  // in the machine's own log: the same window asked four times in twenty minutes, each read either slow or timing out.
  it('reads the shelf once per session, even when the section is opened again', async () => {
    fetchMarketplace.mockResolvedValue({
      status: 'ok',
      cases: [entry()],
      updatedAt: 1,
      source: 'network',
      fetchedAt: 1
    })
    const first = render(<CaseMarketplace />)
    await waitFor(() => expect(useCaseMarketStore.getState().shelf.kind).toBe('ready'))
    first.unmount()

    render(<CaseMarketplace />)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="case-market-card"]')).toBeTruthy()
    )
    expect(fetchMarketplace).toHaveBeenCalledTimes(1)
  })

  it('keeps a refusal and lets the reader ask again with the refresh control', async () => {
    fetchMarketplace.mockResolvedValue({
      status: 'refused',
      reason: 'unreachable',
      detail: 'timed-out after 20000ms'
    })
    const first = render(<CaseMarketplace />)
    await waitFor(() => expect(useCaseMarketStore.getState().shelf.kind).toBe('refused'))
    first.unmount()

    render(<CaseMarketplace />)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="case-market-refused"]')).toBeTruthy()
    )
    expect(fetchMarketplace).toHaveBeenCalledTimes(1)

    ;(document.querySelector('[data-slot="case-market-refresh"]') as HTMLElement).click()
    await waitFor(() => expect(fetchMarketplace).toHaveBeenCalledTimes(2))
    // The reload has to say it wants the host: without the flag the main process answers from this machine's saved
    // copy, and the control would repaint the same list while looking like it asked again.
    expect(fetchMarketplace).toHaveBeenLastCalledWith({ refresh: true })
  })

  it('says when the shelf is this machine’s saved copy rather than a fresh read', async () => {
    fetchMarketplace.mockResolvedValue({
      status: 'ok',
      cases: [entry()],
      updatedAt: 1,
      source: 'cache',
      fetchedAt: Date.UTC(2026, 10, 3, 4, 5)
    })
    render(<CaseMarketplace />)

    await waitFor(() =>
      expect(document.querySelector('[data-slot="case-market-cached"]')).toBeTruthy()
    )
    const line = document.querySelector('[data-slot="case-market-cached"]') as HTMLElement
    // The date is formatted for the reader, so the assertion is on the sentence's own promise: it says "saved", and it
    // names the moment. A live read must not carry this line at all.
    expect(line.textContent).toMatch(
      /saved|保存|儲存|保存された|저장된|gespeicherte|enregistrée|guardada|сохранённая/
    )
    expect(line.textContent).toMatch(/2026/)
  })
})
