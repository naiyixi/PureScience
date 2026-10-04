// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SessionPackageImportRecord } from '../../../../shared/session-package-import'
import { SessionImportPostureBanner } from './SessionImportPostureBanner'

// The record an import leaves beside the session it created. Every field the banner shows is read from
// here — the banner states the record, it does not infer provenance from a title or a flag of its own.
const record: SessionPackageImportRecord = {
  importedAt: '2026-10-04T08:00:00.000Z',
  importedFrom: {
    sessionId: 'source-session',
    projectId: 'source-project',
    appVersion: '1.82.0',
    exportedAt: '2026-09-15T00:00:00.000Z'
  },
  posture: {
    readOnly: true,
    executeAllowed: false,
    continueAllowed: false,
    verificationLabel: 'source-party'
  },
  assertion: { origin: 'source-party', locallyVerified: false },
  notes: ['environment-lock-unavailable']
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const render = (): void => {
  act(() => {
    root.render(<SessionImportPostureBanner record={record} />)
  })
}

describe('SessionImportPostureBanner', () => {
  it('states where the session came from, when it was exported, and that nothing here verified it', () => {
    render()

    const banner = container.querySelector('[data-testid="session-import-posture"]')
    expect(banner).not.toBeNull()
    const text = banner?.textContent ?? ''
    // The three facts the acceptance names, each read from the record.
    expect(text).toContain('source-project')
    expect(text).toContain('source-session')
    expect(text).toContain('1.82.0')
    expect(text).toContain('2026-09-15T00:00:00.000Z')
    expect(text).toContain('Not verified on this machine')
  })

  it('marks the session read-only, and says what read-only means here', () => {
    render()

    const readOnly = container.querySelector('[data-testid="session-import-posture-readonly"]')
    expect(readOnly).not.toBeNull()
    expect(readOnly?.textContent ?? '').toContain('read-only')
    expect(container.textContent ?? '').toContain(
      'you can read and cite them, never run or continue them'
    )
  })

  it('does not reword the posture into a softer claim', () => {
    render()

    const text = container.textContent ?? ''
    // A machine that did not run the work must not say it was verified in any voice: the words that
    // would claim it are absent, and the sentence that denies it is present.
    expect(text).not.toMatch(/verified by this machine|reproduced on this machine|run here/i)
    expect(text).toContain('every conclusion is the sender’s assertion')
  })
})
