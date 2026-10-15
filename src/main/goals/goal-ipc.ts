// Goal IPC handlers: the renderer's settings-panel surface for goals. Read-only on purpose — the panel
// shows what each session is pursuing and what the app's own readings already proved, while every change
// keeps going through the agent-facing goal_configure / goal_advance tools. A goal belongs to a session,
// and progress only moves on a reading the app re-resolves; a settings form can supply neither.

import { ipcMainHandle } from '../ipc-handler-registry'
import type { GoalOverview } from '../../shared/goal'
import type { GoalRepository } from './goal-repository'

export const GOAL_IPC = {
  LIST_ALL: 'goal:list-all'
} as const

export type GoalCommandOwner = {
  listAll: () => Promise<GoalOverview>
}

export const createGoalCommandOwner = (repository: GoalRepository): GoalCommandOwner => ({
  listAll: () => repository.listAll()
})

export const registerGoalIpcHandlers = (owner: GoalCommandOwner): GoalCommandOwner => {
  ipcMainHandle(GOAL_IPC.LIST_ALL, () => owner.listAll())
  return owner
}

export type { GoalOverview }
