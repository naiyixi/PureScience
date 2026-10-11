// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThirdPartyLicensesDialog } from './ThirdPartyLicensesDialog'
import { dictionaries } from '@/i18n/languages'

// The dialog used to re-request the licence list whenever the previous answer was empty (its effect
// depended on `entries.length` and `loading`, so `[]` could never satisfy its own guard). One open
// dialog produced 371 main-process collection runs in 0.228 s on the user's machine, each logging a
// failed read. These cases pin "one request per opening" — including for the empty answer, which is
// exactly the shape the packaged app produces.

const emptyText = dictionaries.en['settings.thirdPartyLicensesEmpty']
const failedText = dictionaries.en['settings.thirdPartyLicensesFailed']

let container: HTMLDivElement
let root: Root
let getThirdPartyLicenses: ReturnType<typeof vi.fn>

const render = async (open: boolean): Promise<void> => {
  await act(async () => {
    root.render(<ThirdPartyLicensesDialog open={open} onOpenChange={vi.fn()} />)
  })
}

// Flushes pending promises and any state updates they schedule, so a loop would have room to run.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

// Radix renders the layer through a Portal into document.body, so the copy is not inside `container`.
const bodyText = (): string => document.body.textContent ?? ''

beforeEach(() => {
  getThirdPartyLicenses = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { settings: { getThirdPartyLicenses } }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ThirdPartyLicensesDialog', () => {
  it('asks exactly once and shows the empty state when the app ships no readable licences', async () => {
    getThirdPartyLicenses.mockResolvedValue([])

    await render(true)
    await settle()

    expect(getThirdPartyLicenses).toHaveBeenCalledTimes(1)
    expect(bodyText()).toContain(emptyText)

    await settle()
    expect(getThirdPartyLicenses).toHaveBeenCalledTimes(1)
  })

  it('lists the licence summaries it received', async () => {
    getThirdPartyLicenses.mockResolvedValue([
      { name: 'zod', version: '4.1.0', license: 'MIT License' }
    ])

    await render(true)
    await settle()

    expect(getThirdPartyLicenses).toHaveBeenCalledTimes(1)
    expect(bodyText()).toContain('zod')
    expect(bodyText()).toContain('v4.1.0')
    expect(bodyText()).toContain('MIT License')
  })

  it('shows the failure text and retries the next time it is opened', async () => {
    getThirdPartyLicenses.mockRejectedValue(new Error('offline'))

    await render(true)
    await settle()

    expect(getThirdPartyLicenses).toHaveBeenCalledTimes(1)
    expect(bodyText()).toContain(failedText)

    await render(false)
    await settle()
    getThirdPartyLicenses.mockResolvedValue([])
    await render(true)
    await settle()

    expect(getThirdPartyLicenses).toHaveBeenCalledTimes(2)
    expect(bodyText()).toContain(emptyText)
  })

  it('does not request anything while it stays closed', async () => {
    await render(false)
    await settle()

    expect(getThirdPartyLicenses).not.toHaveBeenCalled()
  })
})
