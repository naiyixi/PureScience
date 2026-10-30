// @vitest-environment jsdom
//
// E1 — the folded summary row has to be the way back into the work. The default (settled history starts
// collapsed) is decided by the scroller from the transcript order and pinned in the transcript render
// suite; this file pins the half a static render cannot: pressing the summary row asks for the *opposite*
// of what is on screen, with the group's own id. A header that always asked for `true` would look correct
// while expanded and do nothing once collapsed — the exact shape of a dead control.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/message-scroller', () => {
  const Wrapper = ({ children }: { children?: React.ReactNode }): JSX.Element => (
    <div>{children}</div>
  )
  return { MessageScrollerItem: Wrapper }
})

// A stable `t` identity: the real provider is memoised, so a fresh function per render would make any
// effect that lists `t` in its dependencies re-run on every render.
const t = (key: string): string => key
vi.mock('@/i18n', () => ({ useLanguage: () => ({ t }) }))

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ')
}))

import { ToolActivity } from '@/stores/session-store'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import type { ConversationActivityGroupItem } from './workspace-tool-activity-groups'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const activity = (id: string, status: ToolActivity['status']): ToolActivity => ({
  id,
  kind: 'tool',
  title: `Read ${id}`,
  status,
  eventIds: [],
  sortIndex: 1,
  toolKind: 'read',
  createdAt: 1_000,
  updatedAt: 1_200
})

const group = (activities: ToolActivity[]): ConversationActivityGroupItem => ({
  id: 'group-1',
  type: 'activity-group',
  createdAt: 1_000,
  sortIndex: 1,
  activities
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

const renderGroup = async (
  isExpanded: boolean,
  onToggleGroup: (groupId: string, nextExpanded: boolean) => void,
  activities: ToolActivity[] = [activity('tool-1', 'completed')]
): Promise<void> => {
  await act(async () => {
    root.render(
      <WorkspaceActivityGroup
        group={group(activities)}
        isExpanded={isExpanded}
        onToggleGroup={onToggleGroup}
        expansionOverrides={{}}
        onToggleRow={() => undefined}
      />
    )
  })
}

describe('WorkspaceActivityGroup summary row', () => {
  it('asks to open a collapsed group, naming that group', async () => {
    const onToggleGroup = vi.fn()
    await renderGroup(false, onToggleGroup)

    const header = container.querySelector<HTMLButtonElement>('[data-testid="tool-group-header"]')
    expect(header?.getAttribute('aria-expanded')).toBe('false')
    // Collapsed: the work is folded away, the summary row is all that is left.
    expect(container.querySelectorAll('[data-testid="tool-chip"]')).toHaveLength(0)

    await act(async () => header?.click())

    expect(onToggleGroup).toHaveBeenCalledWith('group-1', true)
  })

  it('asks to close an open group', async () => {
    const onToggleGroup = vi.fn()
    await renderGroup(true, onToggleGroup)

    const header = container.querySelector<HTMLButtonElement>('[data-testid="tool-group-header"]')
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('[data-testid="tool-chip"]')).toHaveLength(1)

    await act(async () => header?.click())

    expect(onToggleGroup).toHaveBeenCalledWith('group-1', false)
  })
})
