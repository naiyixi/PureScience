// @vitest-environment jsdom
// Transcript capabilities travel through context so a settled row's props stay stable — flipping
// "can branch into a new session" must re-render only the control that shows it, not every row
// (docs/plan-2026-11-05-transcript-render-architecture.md §5.1). These pin the contract the transcript
// relies on: the provider delivers the value, the default is off, and a memoized row that does not read
// the context keeps its render count across a flip.
import { memo, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTranscriptCapabilities } from './transcript-capabilities-context'
import { TranscriptCapabilitiesProvider } from './transcript-capabilities'

let container: HTMLDivElement
let root: Root

const Probe = (): React.JSX.Element => {
  const { canBranchInNewSession } = useTranscriptCapabilities()
  return <span data-testid="probe">{canBranchInNewSession ? 'enabled' : 'disabled'}</span>
}

const probeText = (): string => container.querySelector('[data-testid="probe"]')?.textContent ?? ''

const renders = vi.fn()
const Heavy = memo(function Heavy({ label }: { label: string }): React.JSX.Element {
  renders(label)
  return <span data-testid="heavy">{label}</span>
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  renders.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('transcript capabilities', () => {
  it('defaults to branch disabled outside a provider', async () => {
    await act(async () => root.render(<Probe />))
    expect(probeText()).toBe('disabled')
  })

  it('delivers the provider value to consumers', async () => {
    await act(async () =>
      root.render(
        <TranscriptCapabilitiesProvider canBranchInNewSession>
          <Probe />
        </TranscriptCapabilitiesProvider>
      )
    )
    expect(probeText()).toBe('enabled')
  })

  it('re-renders only consumers when the capability flips', async () => {
    const tree = (enabled: boolean): React.JSX.Element => (
      <TranscriptCapabilitiesProvider canBranchInNewSession={enabled}>
        <Probe />
        <Heavy label="settled row" />
      </TranscriptCapabilitiesProvider>
    )
    await act(async () => root.render(tree(false)))
    expect(renders).toHaveBeenCalledTimes(1)

    await act(async () => root.render(tree(true)))
    expect(probeText()).toBe('enabled')
    // The settled row's props did not change, so the context flip must not re-render it. That is the
    // whole reason the capability left the row props.
    expect(renders).toHaveBeenCalledTimes(1)
  })
})
