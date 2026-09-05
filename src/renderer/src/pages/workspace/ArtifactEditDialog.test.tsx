// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactEditDialog } from './ArtifactEditDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
}
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {
      /* no-op */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
}

const readPreview = vi.hoisted(() => vi.fn())
const writeUserEditedVersion = vi.hoisted(() => vi.fn())

beforeEach(() => {
  readPreview.mockReset()
  writeUserEditedVersion.mockReset()
  readPreview.mockResolvedValue({
    content: 'line one\nline two\n',
    encoding: 'utf8',
    size: 19,
    truncated: false,
    offset: 0
  })
  writeUserEditedVersion.mockResolvedValue({
    id: 'version-3',
    projectName: 'project-1',
    sessionId: 'session-1',
    runId: 'artifact-run-1',
    name: 'notes.md',
    path: '',
    fileUrl: '',
    mimeType: 'text/markdown',
    size: 30,
    mtimeMs: 3000,
    artifactId: 'artifact-1',
    versionId: 'version-3',
    versionNumber: 3,
    checksum: 'checksum-3',
    createdAt: '2026-09-05T10:00:00.000Z'
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      artifacts: {
        readPreview,
        writeUserEditedVersion
      }
    }
  })
})

const baseProps = {
  name: 'notes.md',
  versionNumber: 2,
  projectId: 'project-1',
  sessionId: 'session-1',
  storageSessionId: 'session-1',
  sourceVersionId: 'version-2',
  path: 'artifact-version:project-1/session-1/artifact-1/version-2',
  contentType: 'text/markdown',
  monospace: false
}

let container: HTMLDivElement
let root: Root

const renderDialog = async ({
  open = true,
  onClose = vi.fn(),
  onSaved = vi.fn()
}: {
  open?: boolean
  onClose?: () => void
  onSaved?: (version: unknown) => void
} = {}): Promise<{ onClose: () => void; onSaved: (version: unknown) => void }> => {
  await act(async () => {
    root.render(
      <ArtifactEditDialog
        {...baseProps}
        open={open}
        onClose={onClose}
        onSaved={(version) => onSaved(version)}
      />
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  return { onClose, onSaved }
}

const findButton = (text: string): HTMLButtonElement | undefined => {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    (button.textContent ?? '').includes(text)
  )
}

const textarea = (): HTMLTextAreaElement => {
  const element = document.body.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Editable artifact content"]'
  )
  if (!element) throw new Error('edit textarea not found')
  return element
}

const setTextareaValue = (value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    if (setter) setter.call(textarea(), value)
    else textarea().value = value
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ArtifactEditDialog', () => {
  it('loads the full artifact text into the editor with Save disabled until a change', async () => {
    await renderDialog()

    expect(textarea().value).toBe('line one\nline two\n')
    expect(findButton('Save')?.disabled).toBe(true)
    expect(readPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'artifact-version:project-1/session-1/artifact-1/version-2',
        encoding: 'utf8',
        offset: 0
      })
    )
  })

  it('publishes edited content as a new version through writeUserEditedVersion', async () => {
    const { onSaved } = await renderDialog()
    setTextareaValue('line one\nline two\nedited')

    const saveButton = findButton('Save')
    expect(saveButton?.disabled).toBe(false)
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(writeUserEditedVersion).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      sourceVersionId: 'version-2',
      content: 'line one\nline two\nedited',
      contentType: 'text/markdown'
    })
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'version-3', versionNumber: 3 })
    )
  })

  it('keeps the dialog open and shows a retryable error when the write fails', async () => {
    writeUserEditedVersion.mockRejectedValue(new Error('write failed'))
    await renderDialog()
    setTextareaValue('edited content')

    const saveButton = findButton('Save')
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save the edited version.'
    )
    expect(textarea().value).toBe('edited content')
    expect(findButton('Save')?.disabled).toBe(false)
  })

  it('asks before discarding unsaved edits; Keep editing returns, Discard closes', async () => {
    const { onClose } = await renderDialog()
    setTextareaValue('unsaved draft')

    const cancelButton = findButton('Cancel')
    await act(async () => {
      cancelButton?.click()
    })
    expect(document.body.textContent).toContain('Discard unsaved changes?')
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      findButton('Keep editing')?.click()
    })
    expect(document.body.textContent).toContain('Edit artifact')
    expect(textarea().value).toBe('unsaved draft')

    await act(async () => {
      findButton('Cancel')?.click()
    })
    await act(async () => {
      findButton('Discard changes')?.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes without prompting when nothing changed', async () => {
    const { onClose } = await renderDialog()
    await act(async () => {
      findButton('Cancel')?.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('Discard unsaved changes?')
  })

  it('refuses oversized artifacts with the too-large message', async () => {
    readPreview.mockResolvedValue({
      content: '',
      encoding: 'utf8',
      size: 30 * 1024 * 1024,
      truncated: false,
      offset: 0
    })
    await renderDialog()

    expect(document.body.textContent).toContain(
      'This artifact is too large to edit in the preview.'
    )
    expect(document.body.querySelector('textarea')).toBeNull()
  })

  it('shows a load-failure state when the content cannot be read', async () => {
    readPreview.mockRejectedValue(new Error('missing version'))
    const { onClose } = await renderDialog()

    expect(document.body.textContent).toContain('Could not load the artifact content for editing.')
    await act(async () => {
      findButton('Cancel')?.click()
    })
    expect(onClose).toHaveBeenCalled()
  })
})
