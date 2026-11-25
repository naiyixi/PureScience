// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RoCrateExportDialog } from './RoCrateExportDialog'

let container: HTMLDivElement
let root: Root
const exportProject = vi.fn()
const inspectExternal = vi.fn()
const pickDirectory = vi.fn()
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

const click = async (testId: string): Promise<void> => {
  await act(async () => {
    container
      .querySelector(`[data-testid="${testId}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** A controlled input only registers a change through its own native setter plus the event it emits. */
const typeInto = async (selector: string, value: string): Promise<void> => {
  const input = container.querySelector<HTMLInputElement>(selector)
  if (input === null) throw new Error(`${selector} was not rendered`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  ;(window as unknown as { api: unknown }).api = {
    roCrate: { exportProject, inspectExternal },
    // The read-only half reuses the existing storage picker rather than adding a native dialogue of
    // its own — so the window's only seam here is the one that already exists.
    storage: { pickDirectory }
  }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  exportProject.mockReset()
  inspectExternal.mockReset()
  pickDirectory.mockReset()
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

  it('states what the surface does with a crate from elsewhere, and offers the check it promises', async () => {
    await render(true)

    // The sentence is a promise: if the entry below were missing, the panel would be describing a
    // capability it does not have.
    expect(container.querySelector('[data-slot="ro-crate-export-only"]')?.textContent).toBe(
      'Writes crates. A crate from elsewhere can also be checked here, read-only, and is never imported into a project.'
    )
    const section = container.querySelector('[data-slot="ro-crate-inspect"]')
    expect(section?.textContent).toContain('Check a crate from elsewhere')
    // What “passed” means is stated before the answer, not discovered after it.
    expect(section?.textContent).toContain('not that the crate is scientifically right')

    // Only a folder stands between the reader and the check — no second, hidden gate that would leave
    // a button on screen which can never be pressed.
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="ro-crate-inspect-submit"]')
        ?.disabled
    ).toBe(true)
    await typeInto('[data-slot="ro-crate-inspect-path"]', '/tmp/foreign-crate')
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="ro-crate-inspect-submit"]')
        ?.disabled
    ).toBe(false)
  })

  it('reports every check that held, and which document was judged', async () => {
    inspectExternal.mockResolvedValue({
      ok: true,
      cratePath: '/tmp/foreign-crate',
      metadataPath: '/tmp/foreign-crate/ro-crate-metadata.json',
      report: {
        ok: true,
        passed: 2,
        failed: 0,
        assertions: [
          { id: 'graph-flattened-entries', level: 'spec-must', requirement: '…', ok: true },
          { id: 'file-sha256-recorded', level: 'export-contract', requirement: '…', ok: true }
        ]
      }
    })
    await render(true)
    await typeInto('[data-slot="ro-crate-inspect-path"]', '/tmp/foreign-crate')
    await click('ro-crate-inspect-submit')

    // The folder travels as the request, exactly as the reader typed it — not resolved, not rewritten.
    expect(inspectExternal).toHaveBeenCalledWith({ cratePath: '/tmp/foreign-crate' })
    expect(container.querySelector('[data-testid="ro-crate-inspect-summary"]')?.textContent).toBe(
      '2 of 2 checks passed — 0 not met.'
    )
    // Which document produced the report: without it, two folders look alike.
    expect(
      container.querySelector('[data-testid="ro-crate-inspect-metadata-path"]')?.textContent
    ).toBe('/tmp/foreign-crate/ro-crate-metadata.json')
    expect(
      container.querySelector('[data-testid="ro-crate-inspect-all-passed"]')?.textContent
    ).toBe('Every check this app can apply passed.')
    expect(container.querySelector('[data-testid="ro-crate-inspect-failed-list"]')).toBeNull()
  })

  it('names each rule that was not met, with the level that says what kind of claim it is', async () => {
    inspectExternal.mockResolvedValue({
      ok: true,
      cratePath: '/tmp/foreign-crate',
      metadataPath: '/tmp/foreign-crate/ro-crate-metadata.json',
      report: {
        ok: false,
        passed: 1,
        failed: 2,
        assertions: [
          { id: 'graph-flattened-entries', level: 'spec-must', requirement: '…', ok: true },
          {
            id: 'metadata-file-descriptor-present',
            level: 'spec-must',
            requirement: '…',
            ok: false,
            detail: 'no CreativeWork with a RO-Crate conformsTo'
          },
          {
            id: 'file-content-size-matches-copied-bytes',
            level: 'export-contract',
            requirement: '…',
            ok: false
          }
        ]
      }
    })
    await render(true)
    await typeInto('[data-slot="ro-crate-inspect-path"]', '/tmp/foreign-crate')
    await click('ro-crate-inspect-submit')

    expect(container.querySelector('[data-testid="ro-crate-inspect-summary"]')?.textContent).toBe(
      '1 of 3 checks passed — 2 not met.'
    )
    // "Not ok" is not an answer: every failing rule is named, and the level says whether it breaks the
    // spec or only this app's own expectation of the crates it writes.
    const list = container.querySelector('[data-testid="ro-crate-inspect-failed-list"]')
    expect(list?.querySelectorAll('li')).toHaveLength(2)
    expect(list?.textContent).toContain('metadata-file-descriptor-present')
    expect(list?.textContent).toContain('required by RO-Crate 1.1')
    expect(list?.textContent).toContain('no CreativeWork with a RO-Crate conformsTo')
    expect(list?.textContent).toContain('file-content-size-matches-copied-bytes')
    expect(list?.textContent).toContain('expected by this app of its own crates')
    // A report with failures is not a success: the all-passed line has no business on screen.
    expect(container.querySelector('[data-testid="ro-crate-inspect-all-passed"]')).toBeNull()
  })

  it.each([
    ['no-metadata-file', 'That folder holds no ro-crate-metadata.json.'],
    ['unreadable', 'ro-crate-metadata.json in that folder could not be read.'],
    ['unparseable', 'ro-crate-metadata.json in that folder is not valid JSON.']
  ] as const)('names %s rather than reporting rules it never read', async (error, message) => {
    inspectExternal.mockResolvedValue({
      ok: false,
      error,
      detail: '/tmp/foreign-crate/ro-crate-metadata.json: raw reader detail'
    })
    await render(true)
    await typeInto('[data-slot="ro-crate-inspect-path"]', '/tmp/foreign-crate')
    await click('ro-crate-inspect-submit')

    // The named refusal comes first; the reader's own text stays under it.
    expect(container.querySelector('[data-testid="ro-crate-inspect-failure"]')?.textContent).toBe(
      message
    )
    expect(
      container.querySelector('[data-testid="ro-crate-inspect-failure-detail"]')?.textContent
    ).toContain('raw reader detail')
    // A refusal judged no rules, so it must never look like a report.
    expect(container.querySelector('[data-testid="ro-crate-inspect-result"]')).toBeNull()
    expect(container.querySelector('[data-testid="ro-crate-inspect-summary"]')).toBeNull()
  })

  it('takes the folder from the existing picker, and a cancelled picker changes nothing', async () => {
    pickDirectory.mockResolvedValueOnce('/tmp/picked-crate')
    await render(true)
    await click('ro-crate-inspect-choose')
    expect(
      container.querySelector<HTMLInputElement>('[data-slot="ro-crate-inspect-path"]')?.value
    ).toBe('/tmp/picked-crate')

    // Cancelling the folder picker is a decision, not a failure: the field keeps what it had and no
    // request is made with a path the reader never chose.
    pickDirectory.mockResolvedValueOnce(null)
    await click('ro-crate-inspect-choose')
    expect(
      container.querySelector<HTMLInputElement>('[data-slot="ro-crate-inspect-path"]')?.value
    ).toBe('/tmp/picked-crate')
    expect(inspectExternal).not.toHaveBeenCalled()
  })
})
