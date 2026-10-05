// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RoCrateExportDialog } from './RoCrateExportDialog'

let container: HTMLDivElement
let root: Root
const exportProject = vi.fn()
const onClose = vi.fn()

const render = async (open: boolean): Promise<void> => {
  await act(async () => {
    root.render(
      <RoCrateExportDialog
        projectId="project-1"
        projectName="Assay project"
        open={open}
        onClose={onClose}
      />
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  ;(window as unknown as { api: unknown }).api = { roCrate: { exportProject } }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  exportProject.mockReset()
  onClose.mockReset()
})

describe('RoCrateExportDialog', () => {
  it('renders nothing at all while closed', async () => {
    await render(false)

    expect(container.querySelector('[data-testid="ro-crate-export-submit"]')).toBeNull()
    expect(exportProject).not.toHaveBeenCalled()
  })

  it('reports where the crate went, how many files it holds, and the validation verdict', async () => {
    exportProject.mockResolvedValue({
      ok: true,
      outputDir: '/tmp/out/assay-ro-crate',
      metadataPath: '/tmp/out/assay-ro-crate/ro-crate-metadata.json',
      fileCount: 3,
      totalBytes: 4096,
      validation: { passed: 30, failed: 0 },
      refusedCount: 1,
      refused: [
        {
          appSessionId: 'session-2',
          artifactId: 'artifact-9',
          versionId: 'version-9',
          reason: 'checksum-mismatch'
        }
      ]
    })
    await render(true)

    await act(async () => {
      container
        .querySelector('[data-testid="ro-crate-export-submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(exportProject).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(
      container.querySelector('[data-testid="ro-crate-export-result"]')?.textContent
    ).toContain('Wrote 3 files to /tmp/out/assay-ro-crate.')
    // The verdict is the writer's own count, not a restatement of "ok".
    expect(container.querySelector('[data-testid="ro-crate-export-validation"]')?.textContent).toBe(
      'RO-Crate verification passed: 30 checks.'
    )
    // A refused version is named as a count, so a smaller crate than expected is never silent.
    expect(container.querySelector('[data-testid="ro-crate-export-refused"]')?.textContent).toBe(
      'Refused 1 published versions whose bytes no longer match the recorded checksum.'
    )
    // …and the count is followed by the list itself: which Version, and why its bytes did not make it in.
    const refusedList = container.querySelector(
      '[data-testid="ro-crate-export-refused-list-success"]'
    )
    expect(refusedList?.textContent).toContain('version-9')
    expect(refusedList?.textContent).toContain('no longer hash to what was recorded')
    expect(refusedList?.querySelectorAll('li')).toHaveLength(1)
  })

  it.each([
    ['project-not-found', 'That project no longer exists.'],
    ['no-published-version', 'This project has no published Artifact Version to export yet.'],
    [
      'no-exportable-version',
      'Every published version was refused: their recorded provenance no longer matches the stored bytes.'
    ],
    ['destination-unwritable', 'The chosen folder could not be written to.'],
    ['validation-failed', 'The exported crate failed RO-Crate verification.'],
    ['write-failed', 'The crate could not be written.']
  ] as const)('names %s instead of a generic apology', async (error, message) => {
    exportProject.mockResolvedValue({ ok: false, error })
    await render(true)

    await act(async () => {
      container
        .querySelector('[data-testid="ro-crate-export-submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="ro-crate-export-failure"]')?.textContent).toBe(
      message
    )
    expect(container.querySelector('[data-testid="ro-crate-export-result"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('treats a closed save sheet as a decision, not a failure', async () => {
    exportProject.mockResolvedValue({ ok: false, error: 'cancelled' })
    await render(true)

    await act(async () => {
      container
        .querySelector('[data-testid="ro-crate-export-submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(onClose).toHaveBeenCalled()
    expect(container.querySelector('[data-testid="ro-crate-export-failure"]')).toBeNull()
  })

  it('lists which versions were refused and why, under the named refusal', async () => {
    exportProject.mockResolvedValue({
      ok: false,
      error: 'no-exportable-version',
      refused: [
        {
          appSessionId: 'session-2',
          artifactId: 'artifact-9',
          versionId: 'version-9',
          reason: 'checksum-mismatch'
        },
        {
          appSessionId: 'session-2',
          artifactId: 'artifact-10',
          versionId: 'version-10',
          reason: 'content-missing'
        }
      ]
    })
    await render(true)

    await act(async () => {
      container
        .querySelector('[data-testid="ro-crate-export-submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    // The named refusal stays the first line; the evidence follows it rather than replacing it.
    expect(container.querySelector('[data-testid="ro-crate-export-failure"]')?.textContent).toBe(
      'Every published version was refused: their recorded provenance no longer matches the stored bytes.'
    )
    const list = container.querySelector('[data-testid="ro-crate-export-refused-list"]')
    expect(list?.querySelectorAll('li')).toHaveLength(2)
    expect(list?.textContent).toContain('version-9')
    expect(list?.textContent).toContain('no longer hash to what was recorded')
    expect(list?.textContent).toContain('version-10')
    expect(list?.textContent).toContain('no longer on disk')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the writer’s own rule-level detail when its assertions failed', async () => {
    exportProject.mockResolvedValue({
      ok: false,
      error: 'validation-failed',
      detail:
        'RO-Crate validation failed: root-data-entity (spec-must): the Root Data Entity MUST be a Dataset whose @id ends with /'
    })
    await render(true)

    await act(async () => {
      container
        .querySelector('[data-testid="ro-crate-export-submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    // The free-text detail is never the only thing on screen: the named failure comes first.
    expect(container.querySelector('[data-testid="ro-crate-export-failure"]')?.textContent).toBe(
      'The exported crate failed RO-Crate verification.'
    )
    expect(
      container.querySelector('[data-testid="ro-crate-export-failure-detail"]')?.textContent
    ).toContain('root-data-entity (spec-must)')
  })

  it('says the surface is export-only, so a missing import is not a mystery', async () => {
    await render(true)

    expect(container.querySelector('[data-slot="ro-crate-export-only"]')?.textContent).toBe(
      'Export only — an external crate cannot be imported or checked here yet.'
    )
  })
})
