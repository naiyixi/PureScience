// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpPermissionRequest } from '../../../../shared/acp'

import { PermissionApprovalControls } from './PermissionApprovalControls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// The receipt type lives with the request it rides on: never a second definition that can drift.
type RiskReview = NonNullable<AcpPermissionRequest['riskReview']>

const reviewReceipt: RiskReview = {
  verdict: 'review',
  ruleSetVersion: 'notebook-run-risk:v1',
  codeHash: 'a'.repeat(64),
  hits: [
    {
      ruleId: 'fs-delete',
      ruleVersion: 'v1',
      lines: [2],
      excerpts: ["shutil.rmtree('/tmp/x')"]
    }
  ]
}

const notebookRequest = (riskReview?: RiskReview): AcpPermissionRequest => ({
  requestId: 'notebook-1',
  sessionId: 'session-1',
  toolCallId: 'tool-notebook',
  title: 'mcp__purescience_notebook__notebook_execute',
  rawInput: { code: "shutil.rmtree('/tmp/x')" },
  ...(riskReview ? { riskReview } : {}),
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
})

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
})

describe('PermissionApprovalControls notebook risk review', () => {
  it('names the fired rule, the id the receipt uses, and the line to read', () => {
    act(() => {
      root.render(
        <PermissionApprovalControls
          requests={[notebookRequest(reviewReceipt)]}
          onRespond={vi.fn()}
        />
      )
    })

    const block = container.querySelector<HTMLElement>('[data-testid="notebook-risk-review"]')
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain('deletes files')
    expect(block!.textContent).toContain('fs-delete')
    expect(block!.textContent).toContain('line 2')
    expect(block!.textContent).toContain("shutil.rmtree('/tmp/x')")
  })

  it('renders nothing for an allow and nothing when no review ran', () => {
    act(() => {
      root.render(
        <PermissionApprovalControls
          requests={[
            notebookRequest({
              verdict: 'allow',
              ruleSetVersion: 'notebook-run-risk:v1',
              codeHash: 'b'.repeat(64),
              hits: []
            })
          ]}
          onRespond={vi.fn()}
        />
      )
    })
    expect(container.querySelector('[data-testid="notebook-risk-review"]')).toBeNull()

    act(() => {
      root.render(<PermissionApprovalControls requests={[notebookRequest()]} onRespond={vi.fn()} />)
    })
    expect(container.querySelector('[data-testid="notebook-risk-review"]')).toBeNull()
  })
})
