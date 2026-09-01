// Routine IPC handlers: the renderer's settings-panel surface for scheduled tasks. The panel
// lists every schedule (list-all), creates/updates one (upsert), deletes one (remove), and
// pauses/resumes (set-enabled). All mutations go through the main-process repository (single
// writer), matching the MCP gateway that the agent-facing routine_* tools use.

import { ipcMainHandle } from '../ipc-handler-registry'
import type { RoutineRepository } from './routine-repository'
import type { RoutineConfigureRequest } from '../../shared/routine'
import type { RoutineSchedule } from '../../shared/routine'

export const ROUTINE_IPC = {
  LIST_ALL: 'routine:list-all',
  UPSERT: 'routine:upsert',
  REMOVE: 'routine:remove',
  SET_ENABLED: 'routine:set-enabled'
} as const

export type RoutineCommandOwner = {
  listAll: () => Promise<RoutineSchedule[]>
  upsert: (sessionId: string, configure: RoutineConfigureRequest) => Promise<RoutineSchedule>
  remove: (sessionId: string, routineId: string) => Promise<boolean>
  setEnabled: (
    sessionId: string,
    routineId: string,
    enabled: boolean
  ) => Promise<RoutineSchedule | null>
}

export const createRoutineCommandOwner = (repository: RoutineRepository): RoutineCommandOwner => ({
  listAll: () => repository.listAllSchedules(),
  upsert: (sessionId, configure) => repository.upsert(sessionId, configure),
  remove: (sessionId, routineId) => repository.remove(sessionId, routineId),
  setEnabled: (sessionId, routineId, enabled) =>
    repository.setEnabled(sessionId, routineId, enabled)
})

export const registerRoutineIpcHandlers = (owner: RoutineCommandOwner): RoutineCommandOwner => {
  ipcMainHandle(ROUTINE_IPC.LIST_ALL, () => owner.listAll())
  ipcMainHandle(
    ROUTINE_IPC.UPSERT,
    (_event, request: { sessionId: string; configure: RoutineConfigureRequest }) =>
      owner.upsert(request.sessionId, request.configure)
  )
  ipcMainHandle(ROUTINE_IPC.REMOVE, (_event, request: { sessionId: string; routineId: string }) =>
    owner.remove(request.sessionId, request.routineId)
  )
  ipcMainHandle(
    ROUTINE_IPC.SET_ENABLED,
    (_event, request: { sessionId: string; routineId: string; enabled: boolean }) =>
      owner.setEnabled(request.sessionId, request.routineId, request.enabled)
  )
  return owner
}

export type { RoutineConfigureRequest, RoutineSchedule }
