// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GoalPanel } from './GoalPanel'

// The panel's job is to show what the app's readings PROVED — and, just as loudly, what they did not. The
// assertions below pin exactly that: a met criterion carries the reading (a run id and the fingerprint the
// app computed), an unmet one says so in words, and a session whose record would not read is named rather
// than folded into "no goals".
vi.mock('@/i18n', () => ({
  useLanguage: (): { t: (key: string) => string } => ({ t: (key: string) => key })
}))

const listAll = vi.fn()

beforeEach(() => {
  listAll.mockReset()
  ;(window as unknown as { api: unknown }).api = { goals: { listAll } }
})

describe('GoalPanel', () => {
  it('shows the reading that met each criterion, and says unmet where there is none', async () => {
    listAll.mockResolvedValue({
      goals: [
        {
          id: 'goal-1',
          sessionId: 'session-a',
          objective: '把方法编译成可调用能力',
          acceptance: [
            {
              id: 'criterion-1',
              text: '运行记录能编译成技能',
              metBy: {
                kind: 'run',
                id: 'notebook-run-9',
                fingerprint: 'b720f53ae927292914b178bd4cf49dd7e'
              }
            },
            { id: 'criterion-2', text: '还没做过的那件事', metBy: null }
          ],
          milestones: [{ id: 'm-1', text: '第一步', done: true }],
          state: 'active',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      unreadableSessionIds: []
    })

    render(<GoalPanel />)

    await waitFor(() => expect(listAll).toHaveBeenCalledOnce())
    // 目标与状态
    expect(await screen.findByText('把方法编译成可调用能力')).toBeTruthy()
    expect(screen.getByText('active')).toBeTruthy()
    // 被读数满足的那条：挂出 run id 与**应用算的**指纹（截断显示）
    expect(screen.getByText(/notebook-run-9/)).toBeTruthy()
    expect(screen.getByText(/b720f53ae927/)).toBeTruthy()
    // 没有读数的那条：必须明说未满足，绝不显示成已完成
    expect(screen.getAllByText('settings.goalsUnmet').length).toBe(1)
    // 未满足的文案旁不出现任何读数标记
    expect(screen.queryByText(/criterion-2.*run/)).toBeNull()
  })

  it('names the sessions whose record would not read instead of hiding them', async () => {
    listAll.mockResolvedValue({ goals: [], unreadableSessionIds: ['session-broken'] })

    render(<GoalPanel />)

    expect(await screen.findByText(/session-broken/)).toBeTruthy()
  })
})
