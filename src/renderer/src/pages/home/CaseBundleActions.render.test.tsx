// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ExportCaseBundle, ImportCaseBundle } from './CaseBundleActions'

const pickDirectory = vi.fn()
const exportBundle = vi.fn()
const importBundle = vi.fn()

beforeEach(() => {
  pickDirectory.mockReset()
  exportBundle.mockReset()
  importBundle.mockReset()
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { storage: { pickDirectory }, caseBundles: { exportBundle, importBundle } }
  })
})

// jsdom has no user-event helper installed here; a click is a click.
const click = (element: HTMLElement): void => {
  element.click()
}

const exportAction = (): HTMLElement =>
  document.querySelector('[data-slot="case-bundle-export-action"]') as HTMLElement
const importAction = (): HTMLElement =>
  document.querySelector('[data-slot="case-bundle-import-action"]') as HTMLElement

describe('exporting a case', () => {
  it('names the project, not the files, and reports where the bundle landed', async () => {
    pickDirectory.mockResolvedValue('/Users/me/Cases')
    exportBundle.mockResolvedValue({
      status: 'exported',
      bundleDir: '/Users/me/Cases/GPCR 激活途径',
      fileCount: 12,
      totalBytes: 3_400_000
    })
    render(<ExportCaseBundle projectId="p6" caseName="GPCR 激活途径" domain="structure" />)

    click(exportAction())

    await waitFor(() => expect(screen.getByText(/12 files/)).toBeTruthy())
    expect(screen.getByText(/GPCR 激活途径/)).toBeTruthy()
    // The window never enumerated anything: it asked main to write this project.
    expect(exportBundle).toHaveBeenCalledWith({
      projectId: 'p6',
      caseName: 'GPCR 激活途径',
      domain: 'structure',
      destinationDir: '/Users/me/Cases'
    })
  })

  it('says nothing at all when the folder picker is cancelled', async () => {
    pickDirectory.mockResolvedValue(null)
    render(<ExportCaseBundle projectId="p6" caseName="c" domain="general" />)

    click(exportAction())

    await waitFor(() => expect(exportBundle).not.toHaveBeenCalled())
    expect(screen.queryByText(/files/)).toBeNull()
  })

  it('reports a refusal as a refusal — and never shows a written bundle', async () => {
    pickDirectory.mockResolvedValue('/Users/me/Cases')
    exportBundle.mockResolvedValue({
      status: 'refused',
      reason: 'unreadable',
      detail: 'outside the workspace'
    })
    render(<ExportCaseBundle projectId="p6" caseName="c" domain="general" />)

    click(exportAction())

    await waitFor(() =>
      expect(screen.getByText(/could not be resolved, so nothing was written/)).toBeTruthy()
    )
    // The resolver's own words travel with the refusal.
    expect(screen.getByText('outside the workspace')).toBeTruthy()
    expect(screen.queryByText(/Wrote/)).toBeNull()
  })
})

describe('importing a case bundle', () => {
  it('lists the offending names when the bundle does not add up, and copies nothing', async () => {
    pickDirectory.mockResolvedValue('/Users/me/Downloads/broken-case')
    importBundle.mockResolvedValue({
      status: 'refused',
      reason: 'incomplete',
      problematic: {
        missing: ['figure.png'],
        checksumMismatch: ['report.md'],
        unexpected: ['stowaway.exe']
      }
    })
    render(<ImportCaseBundle />)

    click(importAction())

    await waitFor(() => expect(screen.getByText(/does not add up/)).toBeTruthy())
    expect(screen.getByText(/Missing: figure\.png/)).toBeTruthy()
    expect(screen.getByText(/Changed since it was packed: report\.md/)).toBeTruthy()
    expect(screen.getByText(/Not in the manifest: stowaway\.exe/)).toBeTruthy()
    // A bundle that fails verification is never offered a destination.
    expect(pickDirectory).toHaveBeenCalledTimes(1)
  })

  it('verifies first, and says nothing was copied when no destination was chosen', async () => {
    pickDirectory.mockResolvedValueOnce('/Users/me/Downloads/good-case').mockResolvedValueOnce(null)
    importBundle.mockResolvedValue({
      status: 'imported',
      name: 'GPCR 激活途径',
      domain: 'structure',
      fileCount: 12,
      totalBytes: 1024,
      manifest: {
        format: 'purescience.case-bundle',
        version: 1,
        name: 'x',
        domain: 'x',
        createdAt: 1,
        files: []
      }
    })
    render(<ImportCaseBundle />)

    click(importAction())

    await waitFor(() => expect(screen.getByText(/Nothing was copied/)).toBeTruthy())
    // Only the verification ran; no write was requested.
    expect(importBundle).toHaveBeenCalledWith({ bundleDir: '/Users/me/Downloads/good-case' })
  })

  it('copies into the chosen folder once the bundle verifies', async () => {
    pickDirectory
      .mockResolvedValueOnce('/Users/me/Downloads/good-case')
      .mockResolvedValueOnce('/Users/me/Cases/imported')
    importBundle
      .mockResolvedValueOnce({
        status: 'imported',
        name: 'GPCR 激活途径',
        domain: 'structure',
        fileCount: 12,
        totalBytes: 1024,
        manifest: {
          format: 'purescience.case-bundle',
          version: 1,
          name: 'x',
          domain: 'x',
          createdAt: 1,
          files: []
        }
      })
      .mockResolvedValueOnce({
        status: 'imported',
        name: 'GPCR 激活途径',
        domain: 'structure',
        fileCount: 12,
        totalBytes: 1024,
        materialisedTo: '/Users/me/Cases/imported',
        manifest: {
          format: 'purescience.case-bundle',
          version: 1,
          name: 'x',
          domain: 'x',
          createdAt: 1,
          files: []
        }
      })
    render(<ImportCaseBundle />)

    click(importAction())

    await waitFor(() => expect(screen.getByText(/Copied 12 files/)).toBeTruthy())
    expect(importBundle).toHaveBeenLastCalledWith({
      bundleDir: '/Users/me/Downloads/good-case',
      materialiseTo: '/Users/me/Cases/imported'
    })
  })
})
