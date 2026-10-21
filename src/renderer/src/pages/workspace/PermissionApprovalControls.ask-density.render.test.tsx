// @vitest-environment jsdom
//
// P0-9's readout: how often this conversation has actually put an approval card in front of the
// reader, and how much of that was the same tool being asked about again.
//
// Why this suite renders the real component through the real language provider: the number is only
// worth anything if the user can see it. A unit test of the ledger proves the arithmetic; this suite
// proves the arithmetic reaches the card, in the reader's language, and that re-rendering the same
// card does not inflate it (the approval surface re-renders on every runtime snapshot).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import { LanguageProvider } from '@/i18n'
import { resetPermissionAskLedger } from '@/lib/permission-ask-ledger'
import { PermissionApprovalControls } from './PermissionApprovalControls'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resetPermissionAskLedger()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.setItem('purescience-language', 'zh')
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  window.localStorage.clear()
})

const card = (requestId: string, providerToolName: string): AcpPermissionRequest => ({
  requestId,
  sessionId: 'session-1',
  toolCallId: `tool-${requestId}`,
  title: `${providerToolName} call`,
  providerToolName,
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
})

const render = (request: AcpPermissionRequest): void => {
  act(() =>
    root.render(
      <LanguageProvider>
        <PermissionApprovalControls requests={[request]} onRespond={() => undefined} />
      </LanguageProvider>
    )
  )
}

const density = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-testid="permission-ask-density"]')

describe('the approval card says how dense the asking has become', () => {
  it('stays quiet on the first card', () => {
    render(card('r1', 'Bash'))

    expect(density()).toBeNull()
  })

  it('counts the second ask and names how many of them repeated a tool', () => {
    render(card('r1', 'Bash'))
    render(card('r2', 'Bash'))

    const line = density()
    expect(line?.textContent).toContain('本会话已询问 2 次')
    expect(line?.textContent).toContain('其中 1 次是同一工具的重复询问')
    // The card reads in the reader's language: no English sentence leaks in with the number.
    expect(line?.textContent).not.toContain('approval requests')
  })

  it('does not inflate the count when the same card re-renders', () => {
    const second = card('r2', 'Bash')
    render(card('r1', 'Bash'))
    render(second)
    render(second)
    render({ ...second })

    expect(density()?.textContent).toContain('本会话已询问 2 次')
  })

  it('drops the repeat clause when the new ask is a different tool', () => {
    render(card('r1', 'Bash'))
    render(card('r2', 'Read'))

    const line = density()
    expect(line?.textContent).toContain('本会话已询问 2 次')
    expect(line?.textContent).not.toContain('重复')
  })
})
