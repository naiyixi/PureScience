// Host-query IPC handlers: the renderer's surface for the read-only introspection engine (used
// by future UI; the agent-facing host_query tool goes through the RPC gateway).

import { ipcMainHandle } from '../ipc-handler-registry'
import type { HostQueryService } from './host-query-service'
import type { HostQueryResult } from '../../shared/host-query'

export const HOST_QUERY_IPC = {
  RUN: 'query:run'
} as const

export type HostQueryCommandOwner = {
  run: (projectId: string, sql: string) => Promise<HostQueryResult>
}

export const createHostQueryCommandOwner = (service: HostQueryService): HostQueryCommandOwner => ({
  run: (projectId, sql) => service.query(sql, projectId)
})

export const registerHostQueryIpcHandlers = (owner: HostQueryCommandOwner): HostQueryCommandOwner => {
  ipcMainHandle(
    HOST_QUERY_IPC.RUN,
    (_event, request: { projectId: string; sql: string }) =>
      owner.run(request.projectId, request.sql)
  )
  return owner
}

export type { HostQueryResult }
