// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PublishCase } from './PublishCase'

// The publish form has one promise to keep: what it says afterwards matches what the main process answered.
// A refusal that reads "published" would be worse than no feature at all, so each refusal code is exercised.

const publish = vi.fn()

beforeEach(() => {
  publish.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { caseBundles: { publish } }
  })
})

afterEach(() => cleanup())

const fill = (): void => {
  fireEvent.change(document.querySelector('[data-slot="case-publish-id"]') as HTMLElement, {
    target: { value: 'gpcr-activation' }
  })
  fireEvent.change(document.querySelector('[data-slot="case-publish-summary"]') as HTMLElement, {
    target: { value: '采样收敛与滞后审计' }
  })
  fireEvent.change(document.querySelector('[data-slot="case-publish-author"]') as HTMLElement, {
    target: { value: 'naiyixi' }
  })
  fireEvent.change(document.querySelector('[data-slot="case-publish-license"]') as HTMLElement, {
    target: { value: 'MIT' }
  })
}

const open = (): void => {
  render(<PublishCase projectId="p6" caseName="GPCR 激活途径" domain="structure" />)
  fireEvent.click(document.querySelector('[data-slot="case-publish-open"]') as HTMLElement)
}

describe('publishing a case from the window', () => {
  it('sends the project and the words on the card, and reports what came back', async () => {
    publish.mockResolvedValue({
      status: 'published',
      id: 'gpcr-activation',
      fileCount: 6,
      totalBytes: 1_774_692,
      bundleSha256: 'abcdef0123456789'.repeat(4),
      archiveBytes: 1_700_000,
      indexUrl: 'https://example.test/index.json',
      verified: true
    })
    open()
    fill()
    fireEvent.click(document.querySelector('[data-slot="case-publish-submit"]') as HTMLElement)

    await waitFor(() => {
      expect(document.querySelector('[data-slot="case-publish-done"]')).not.toBeNull()
    })
    expect(publish).toHaveBeenCalledWith({
      projectId: 'p6',
      draft: {
        id: 'gpcr-activation',
        name: 'GPCR 激活途径',
        domain: 'structure',
        summary: '采样收敛与滞后审计',
        author: 'naiyixi',
        license: 'MIT'
      }
    })
    // The digest is shown, shortened: enough to compare by eye against the index, not enough to be a claim of its own.
    expect(screen.getByText(/abcdef012345/)).toBeTruthy()
  })

  it('says the credential is missing instead of pretending the upload failed', async () => {
    publish.mockResolvedValue({
      status: 'refused',
      reason: 'no-credential',
      detail: 'gh auth login'
    })
    open()
    fill()
    fireEvent.click(document.querySelector('[data-slot="case-publish-submit"]') as HTMLElement)

    await waitFor(() => {
      expect(document.querySelector('[data-slot="case-publish-error"]')).not.toBeNull()
    })
    // Both the reason and the detail mention the command; the panel is what gets read, so assert on it.
    const panel = document.querySelector('[data-slot="case-publish-error"]') as HTMLElement
    expect(panel.textContent).toMatch(/gh auth login/)
    expect(document.querySelector('[data-slot="case-publish-done"]')).toBeNull()
  })

  it('reports a read-back failure as "not published", not as a warning', async () => {
    publish.mockResolvedValue({ status: 'refused', reason: 'verify-failed', detail: 'digest' })
    open()
    fill()
    fireEvent.click(document.querySelector('[data-slot="case-publish-submit"]') as HTMLElement)

    await waitFor(() => {
      expect(document.querySelector('[data-slot="case-publish-error"]')).not.toBeNull()
    })
    const panel = document.querySelector('[data-slot="case-publish-error"]') as HTMLElement
    expect(panel.textContent).toMatch(/digest/i)
    expect(document.querySelector('[data-slot="case-publish-done"]')).toBeNull()
  })
})
