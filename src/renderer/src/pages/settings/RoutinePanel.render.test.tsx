// @vitest-environment jsdom
// Render + interaction tests for the RoutinePanel (scheduled tasks settings panel).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  useLanguage: () => {
    const labels: Record<string, string> = {
      'settings.routineDesc': 'Recurring instructions.',
      'settings.routineRefresh': 'Refresh',
      'settings.routineNew': 'New schedule',
      'settings.routineInstruction': 'Instruction',
      'settings.routineInstructionPlaceholder': 'What should each run do?',
      'settings.routineInterval': 'Interval (minutes)',
      'settings.routineIntervalHint': 'Between 5 and 1440 minutes.',
      'settings.routineLabel': 'Label (optional)',
      'settings.routineLabelPlaceholder': 'e.g. weekly variant check',
      'settings.routineCreate': 'Create',
      'settings.cancel': 'Cancel',
      'settings.routineLoading': 'Loading scheduled tasks…',
      'settings.routineEmpty': 'No scheduled tasks yet.',
      'settings.routineEmptyHint': 'Ask an agent to schedule recurring work.',
      'settings.routinePaused': 'paused',
      'settings.routineDue': 'due now',
      'settings.routineMinutes': 'min',
      'settings.routineHours': 'h',
      'settings.routineEvery': 'Every',
      'settings.routineTicks': 'runs',
      'settings.routinePause': 'Pause',
      'settings.routineResume': 'Resume',
      'settings.routineDelete': 'Delete',
      'settings.routineStuck': 'paused (repeated failures)'
    }
    return { t: (key: string): string => labels[key] ?? key }
  }
}))

const { RoutinePanel } = await import('./RoutinePanel')
import type { RoutineSchedule } from '../../../../shared/routine'

const routineFixture: RoutineSchedule[] = [
  {
    id: 'routine-1',
    sessionId: 'session-1',
    label: 'weekly variants',
    instruction: 'Check for new variants and summarize.',
    everyMinutes: 60,
    enabled: true,
    nextDue: Date.now() + 30 * 60_000,
    lastFireAt: Date.now() - 60 * 60_000,
    lastOkAt: Date.now() - 60 * 60_000,
    tickCount: 3,
    missedTicks: 0,
    idleStreak: 0,
    pausedReason: null,
    lastResults: [],
    createdAt: Date.now() - 3 * 60 * 60_000,
    updatedAt: Date.now() - 60 * 60_000
  },
  {
    id: 'routine-2',
    sessionId: 'session-1',
    label: undefined,
    instruction: 'Stuck routine.',
    everyMinutes: 30,
    enabled: false,
    nextDue: null,
    lastFireAt: Date.now() - 2 * 60 * 60_000,
    lastOkAt: null,
    tickCount: 2,
    missedTicks: 2,
    idleStreak: 3,
    pausedReason: 'stuck',
    lastResults: [],
    createdAt: Date.now() - 4 * 60 * 60_000,
    updatedAt: Date.now() - 2 * 60 * 60_000
  }
]

describe('RoutinePanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.api = {
      ...(window.api ?? {}),
      routine: {
        listAll: vi.fn(async () => []),
        upsert: vi.fn(async () => routineFixture[0]),
        remove: vi.fn(async () => true),
        setEnabled: vi.fn(async () => null)
      }
    } as unknown as typeof window.api
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
  })

  it('renders the empty state when no schedules exist', async () => {
    vi.spyOn(window.api.routine, 'listAll').mockResolvedValue([])
    await act(async () => {
      root.render(<RoutinePanel />)
    })
    expect(container.textContent).toContain('No scheduled tasks yet.')
  })

  it('lists schedules with label, instruction, interval and run counts', async () => {
    vi.spyOn(window.api.routine, 'listAll').mockResolvedValue(routineFixture)
    await act(async () => {
      root.render(<RoutinePanel />)
    })
    expect(container.textContent).toContain('weekly variants')
    expect(container.textContent).toContain('Check for new variants and summarize.')
    expect(container.textContent).toContain('Every 60 min')
    expect(container.textContent).toContain('runs: 3')
    // Stuck badge is shown for the auto-paused schedule.
    expect(container.textContent).toContain('paused (repeated failures)')
  })

  it('creates a routine from the form and reloads the list', async () => {
    const listAll = vi
      .spyOn(window.api.routine, 'listAll')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(routineFixture)
    const upsert = vi.spyOn(window.api.routine, 'upsert').mockResolvedValue(routineFixture[0])

    await act(async () => {
      root.render(<RoutinePanel />)
    })
    expect(container.textContent).toContain('No scheduled tasks yet.')

    // Open the form and fill it.
    const newButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('New schedule')
    )
    expect(newButton).toBeDefined()
    await act(async () => {
      newButton!.click()
    })

    const instruction = container.querySelector('#routine-instruction') as HTMLTextAreaElement
    const interval = container.querySelector('#routine-interval') as HTMLInputElement
    expect(instruction).toBeTruthy()
    expect(interval).toBeTruthy()

    await act(async () => {
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      const textareaSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set
      if (textareaSetter) textareaSetter.call(instruction, 'Check for new variants.')
      instruction.dispatchEvent(new Event('input', { bubbles: true }))
      if (inputSetter) inputSetter.call(interval, '45')
      interval.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const createButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Create')
    )
    expect(createButton).toBeDefined()
    await act(async () => {
      createButton!.click()
    })

    expect(upsert).toHaveBeenCalledWith({
      sessionId: 'settings-panel',
      configure: { everyMinutes: 45, instruction: 'Check for new variants.' }
    })
    expect(listAll).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('weekly variants')
  })

  it('toggles a schedule paused/resumed via setEnabled', async () => {
    vi.spyOn(window.api.routine, 'listAll').mockResolvedValue(routineFixture)
    const setEnabled = vi
      .spyOn(window.api.routine, 'setEnabled')
      .mockResolvedValue(routineFixture[0])
    await act(async () => {
      root.render(<RoutinePanel />)
    })

    const pauseButtons = [...container.querySelectorAll('button')].filter((button) =>
      button.getAttribute('aria-label')?.includes('Pause')
    )
    expect(pauseButtons.length).toBe(1) // only the enabled schedule has Pause
    await act(async () => {
      pauseButtons[0].click()
    })
    expect(setEnabled).toHaveBeenCalledWith({
      sessionId: 'session-1',
      routineId: 'routine-1',
      enabled: false
    })
  })

  it('deletes a schedule via remove', async () => {
    vi.spyOn(window.api.routine, 'listAll').mockResolvedValue(routineFixture)
    const remove = vi.spyOn(window.api.routine, 'remove').mockResolvedValue(true)
    await act(async () => {
      root.render(<RoutinePanel />)
    })

    const deleteButtons = [...container.querySelectorAll('button')].filter((button) =>
      button.getAttribute('aria-label')?.includes('Delete')
    )
    expect(deleteButtons.length).toBe(2)
    await act(async () => {
      deleteButtons[0].click()
    })
    expect(remove).toHaveBeenCalledWith({ sessionId: 'session-1', routineId: 'routine-1' })
  })
})
