// @vitest-environment jsdom
import { Dialog } from 'radix-ui'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FolderGrantsPanel } from '@/components/FolderGrantsPanel'
import { ReferencesLibraryDialog } from '@/components/references/ReferencesLibraryDialog'
import { LanguageProvider } from '@/i18n'
import { AnnotationDialog } from '@/pages/workspace/AnnotationDialog'
import { SessionBookmarksDialog } from '@/pages/workspace/SessionBookmarksDialog'
import { SessionInfoCard } from '@/pages/workspace/SessionInfoCard'

// Every overlay must be dismissable from the keyboard, land focus inside itself when it opens, and
// hand focus back to whatever opened it. These four were hand-rolled containers with only a
// backdrop click, so Escape did nothing and focus stayed wherever it was — including behind the
// overlay. They now ride the same Radix dialog shell as the rest of the app; this file pins the
// behaviour so a future rewrite back to a plain div fails loudly.

const installApiStub = (): void => {
  ;(window as unknown as { api: unknown }).api = {
    folderGrants: { list: vi.fn(async () => ({ grants: [] })) },
    localFs: { listDir: vi.fn(async () => ({ resolvedPath: '', entries: [] })) },
    bookmark: { list: vi.fn(async () => []) },
    annotation: { list: vi.fn(async () => []) },
    references: {
      list: vi.fn(async () => []),
      listCollections: vi.fn(async () => []),
      listCitationStyles: vi.fn(async () => [])
    }
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  installApiStub()
  // Radix marks the body non-interactive while a modal is open and clears it on unmount; jsdom
  // also refuses to focus anything inside a `pointer-events: none` body, so start each case clean.
  document.body.removeAttribute('style')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const render = (element: React.JSX.Element): void => {
  act(() => {
    root.render(<LanguageProvider>{element}</LanguageProvider>)
  })
}

const pressEscape = (): void => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

const openPanel = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]')

const overlays: Array<{
  name: string
  element: (open: boolean, onClose: () => void) => React.JSX.Element
}> = [
  {
    name: 'folder grants panel',
    element: (open, onClose) => <FolderGrantsPanel open={open} onClose={onClose} />
  },
  {
    name: 'session bookmarks dialog',
    element: (open, onClose) => (
      <SessionBookmarksDialog open={open} onClose={onClose} sessionId="session-1" />
    )
  },
  {
    name: 'annotation dialog',
    element: (open, onClose) => (
      <AnnotationDialog
        open={open}
        onClose={onClose}
        projectId="project-1"
        target="analysis/report.md"
      />
    )
  },
  {
    name: 'references library dialog',
    element: (open, onClose) => (
      <ReferencesLibraryDialog open={open} onClose={onClose} projectId="project-1" />
    )
  }
]

describe('overlay keyboard exit', () => {
  it.each(overlays)('$name closes on Escape', ({ element }) => {
    const onClose = vi.fn()
    render(element(true, onClose))

    expect(openPanel()).not.toBeNull()
    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the folder grants panel when it opens', () => {
    render(<FolderGrantsPanel open onClose={() => undefined} />)

    const panel = openPanel()
    const active = document.activeElement

    expect(panel).not.toBeNull()
    expect(active).not.toBe(document.body)
    expect(panel?.contains(active)).toBe(true)
    // The path field, not the close button: opening this panel is a request to browse to a folder.
    expect((active as HTMLElement)?.tagName).toBe('INPUT')
  })

  it.each(overlays)('$name hands focus back to the control that opened it', async ({ element }) => {
    const Harness = ({ open }: { open: boolean }): React.JSX.Element => (
      <>
        <button type="button" data-testid="trigger">
          open
        </button>
        {element(open, () => undefined)}
      </>
    )

    // Radix clears its body-level modal styles inside a timer; drain those first, then drop what is
    // left, or the focus call below lands in a `pointer-events: none` body and jsdom refuses it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    document.body.removeAttribute('style')
    document.body.style.pointerEvents = ''
    document.body.style.overflow = ''

    // The opener lives outside the dialog on purpose: the pages that own these flags open them from
    // their own buttons, so there is no Radix `Dialog.Trigger` to restore to.
    const trigger = document.createElement('button')
    trigger.textContent = 'open'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    render(<Harness open />)
    expect(openPanel()?.contains(document.activeElement)).toBe(true)

    await act(async () => {
      root.render(
        <LanguageProvider>
          <Harness open={false} />
        </LanguageProvider>
      )
      // FocusScope hands focus back inside a macrotask that is scheduled while this render's effects
      // flush, so give the timer room to run before asserting.
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
  it('closes the session info card on Escape — it had no keyboard exit at all', () => {
    const onClose = vi.fn()
    render(
      <SessionInfoCard
        session={
          {
            id: 'session-1',
            projectId: 'project-1',
            title: 'Protein design',
            cwd: '/workspace',
            status: 'idle',
            messages: [],
            artifacts: [],
            createdAt: 1,
            updatedAt: 2
          } as never
        }
        onClose={onClose}
      />
    )

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to a dialog stacked above the session info card', () => {
    const onClose = vi.fn()
    const Stack = (): React.JSX.Element => {
      const [dialogOpen, setDialogOpen] = useState(true)
      return (
        <>
          <SessionInfoCard
            session={
              {
                id: 'session-1',
                projectId: 'project-1',
                title: 'Protein design',
                cwd: '/workspace',
                status: 'idle',
                messages: [],
                artifacts: [],
                createdAt: 1,
                updatedAt: 2
              } as never
            }
            onClose={onClose}
          />
          <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
            <Dialog.Portal>
              <Dialog.Content aria-label="stacked">
                <Dialog.Title>stacked</Dialog.Title>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </>
      )
    }

    render(<Stack />)

    pressEscape()
    // The first Escape belongs to the dialog on top of the card, not to the card.
    expect(onClose).not.toHaveBeenCalled()

    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
