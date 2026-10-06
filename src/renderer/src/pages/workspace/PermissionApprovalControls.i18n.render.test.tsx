// @vitest-environment jsdom
//
// The approval prompt is a blocking decision surface: before this, a Chinese user read "Allow once" /
// "Deny" / English scope sentences on it while the rest of the app spoke their language. Keying the
// copy is not the deliverable — the screen changing is. So this suite renders the real component
// through the real language provider in zh and asserts the words the user reads.
//
// Boundary: the scope sentences live in the info tooltip, and Radix renders tooltip content into a
// portal only while it is open. This suite therefore asserts the always-on parts (both buttons, the
// scope word composed into the Allow button, the info affordance's accessible name); the sentence
// values themselves are held by the nine-dictionary coverage gate.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import { LanguageProvider } from '@/i18n'
import { PermissionApprovalControls } from './PermissionApprovalControls'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  window.localStorage.clear()
})

// option kinds are the protocol's, and the panel derives its scope picker from them.
const onceOnlyRequest: AcpPermissionRequest = {
  requestId: 'perm-once',
  sessionId: 'session-1',
  toolCallId: 'tool-once',
  title: 'ls -la /tmp',
  providerToolName: 'Bash',
  toolKind: 'execute',
  rawInput: { command: 'ls -la /tmp' },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
}

const renderInChinese = (request: AcpPermissionRequest): void => {
  window.localStorage.setItem('purescience-language', 'zh')
  act(() =>
    root.render(
      <LanguageProvider>
        <PermissionApprovalControls requests={[request]} onRespond={() => undefined} />
      </LanguageProvider>
    )
  )
}

describe('PermissionApprovalControls reads the decision in the user’s language', () => {
  it('composes the Allow button from the dictionary instead of hardcoded English', () => {
    renderInChinese(onceOnlyRequest)

    const allow = document.body.querySelector('[data-testid="allow-primary"]')
    expect(allow?.textContent).toContain('允许')
    expect(allow?.textContent).toContain('仅此一次')
    expect(allow?.textContent).not.toContain('Allow')
    expect(allow?.textContent).not.toContain('once')
  })

  it('localises the Deny button and the info affordance', () => {
    renderInChinese(onceOnlyRequest)

    expect(document.body.querySelector('[data-testid="deny-button"]')?.textContent).toBe('拒绝')
    // The info button's accessible name is the surface that carries the scope sentences.
    expect(
      document.body.querySelector('[data-testid="permission-tool-info"]')?.getAttribute('aria-label')
    ).toBe('权限信息')
  })

  it('shows the session scope word on a request that offers one', () => {
    // The session/project words were already keyed; this keeps the whole composed button honest —
    // "允许 用于此会话" is the same sentence the English UI shows as "Allow for this session".
    const sessionScoped: AcpPermissionRequest = {
      ...onceOnlyRequest,
      requestId: 'perm-session',
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
      ]
    }
    renderInChinese(sessionScoped)

    const allow = document.body.querySelector('[data-testid="allow-primary"]')
    expect(allow?.textContent).toContain('允许')
    expect(allow?.textContent).toContain('用于此会话')
    expect(allow?.textContent).not.toContain('this session')
  })
})
