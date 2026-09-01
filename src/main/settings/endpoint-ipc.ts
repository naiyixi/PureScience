// Managed-endpoint IPC handlers: the renderer's settings-panel surface for local model
// services. The panel lists every endpoint (list-all), registers one (register), approves a
// pending script set (approve — the first registration of a given script bytes is hash-pinned
// only after the user approves it in the panel), and manages lifecycle (start/stop) plus
// removal (remove). All mutations go through the main-process repository + manager (single
// writer), matching the RPC gateway the agent-facing endpoint_* tools use.

import { ipcMainHandle } from '../ipc-handler-registry'
import type { EndpointManager } from './endpoint-manager'
import type { EndpointRepository } from './endpoint-repository'
import type { EndpointRegisterRequest, ManagedEndpoint } from '../../shared/endpoint'

export const ENDPOINT_IPC = {
  LIST_ALL: 'endpoint:list-all',
  REGISTER: 'endpoint:register',
  APPROVE: 'endpoint:approve',
  START: 'endpoint:start',
  STOP: 'endpoint:stop',
  REMOVE: 'endpoint:remove'
} as const

export type EndpointCommandOwner = {
  listAll: () => Promise<ManagedEndpoint[]>
  register: (
    sessionId: string,
    request: EndpointRegisterRequest
  ) => Promise<{ endpoint: ManagedEndpoint; newlyApproved: boolean }>
  approve: (name: string) => Promise<boolean>
  start: (name: string) => Promise<ManagedEndpoint>
  stop: (name: string) => Promise<ManagedEndpoint>
  remove: (name: string) => Promise<boolean>
}

export const createEndpointCommandOwner = (
  repository: EndpointRepository,
  manager: EndpointManager
): EndpointCommandOwner => ({
  listAll: () => repository.list(),
  register: (sessionId, request) => repository.upsert(request, sessionId),
  approve: async (name) => {
    const endpoint = await repository.get(name)
    if (!endpoint) return false
    await repository.approveHash(endpoint.approvedScriptHash)
    return true
  },
  start: async (name) => {
    const result = await manager.start(name)
    return result.endpoint
  },
  stop: async (name) => {
    const result = await manager.stop(name)
    return result.endpoint
  },
  remove: (name) => manager.unregister(name)
})

export const registerEndpointIpcHandlers = (
  owner: EndpointCommandOwner
): EndpointCommandOwner => {
  ipcMainHandle(ENDPOINT_IPC.LIST_ALL, () => owner.listAll())
  ipcMainHandle(
    ENDPOINT_IPC.REGISTER,
    (_event, request: { sessionId: string; request: EndpointRegisterRequest }) =>
      owner.register(request.sessionId, request.request)
  )
  ipcMainHandle(ENDPOINT_IPC.APPROVE, (_event, name: string) => owner.approve(name))
  ipcMainHandle(ENDPOINT_IPC.START, (_event, name: string) => owner.start(name))
  ipcMainHandle(ENDPOINT_IPC.STOP, (_event, name: string) => owner.stop(name))
  ipcMainHandle(ENDPOINT_IPC.REMOVE, (_event, name: string) => owner.remove(name))
  return owner
}

export type { EndpointRegisterRequest, ManagedEndpoint }
