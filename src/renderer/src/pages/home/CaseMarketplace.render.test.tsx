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
  // The shelf lives in a store, so every test starts from "nothing read yet".
  useCaseMarketStore.setState({ shelf: { kind: 'loading' }, install: { kind: 'idle' } })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { caseBundles: { fetchMarketplace, installFromMarketplace } }
  })
})

afterEach(() => cleanup())

const installButton = (): HTMLElement =>
  document.querySelector('[data-slot="case-market-install"]') as HTMLElement

describe('the case marketplace shelf', () => {
  it('shows what a published index says: whose it is, what it holds, and its licence', async () => {
    fetchMarketplace.mockResolvedValue({ status: 'ok', cases: [entry()], updatedAt: 1 })
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
    fetchMarketplace.mockResolvedValue({ status: 'ok', cases: [entry()], updatedAt: 1 })
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
    fetchMarketplace.mockResolvedValue({ status: 'ok', cases: [entry()], updatedAt: 1 })
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
      updatedAt: 1
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
})
