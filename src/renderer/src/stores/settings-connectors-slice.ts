import type {
  AddCustomServerRequest,
  ApprovalDecision,
  AuthenticateCustomServerRequest,
  ConnectorApprovalRequest,
  ConnectorDetailView,
  SetConnectorsEnabledItemResult,
  ConnectorView,
  CustomServerView,
  NcbiCredentialsView,
  SetNcbiCredentialsRequest,
  ToolPermission,
  UpdateCustomServerRequest
} from '../../../shared/settings'

type SettingsConnectorsProjection = {
  connectors: ConnectorView[]
  customServers: CustomServerView[]
  ncbi: NcbiCredentialsView
}

export type SettingsConnectorsState = SettingsConnectorsProjection & {
  pendingApprovals: ConnectorApprovalRequest[]
}

export type SettingsConnectorsActions = {
  loadConnectors: () => Promise<void>
  setConnectorEnabled: (id: string, enabled: boolean) => Promise<void>
  setConnectorsEnabled: (
    ids: readonly string[],
    enabled: boolean
  ) => Promise<readonly SetConnectorsEnabledItemResult[]>
  setConnectorAutoAllow: (id: string, autoAllow: boolean) => Promise<void>
  setToolPermission: (toolId: string, permission: ToolPermission) => Promise<ConnectorDetailView>
  setNcbiCredentials: (request: SetNcbiCredentialsRequest) => Promise<void>
  addCustomServer: (request: AddCustomServerRequest) => Promise<void>
  updateCustomServer: (request: UpdateCustomServerRequest) => Promise<void>
  authenticateCustomServer: (request: AuthenticateCustomServerRequest) => Promise<void>
  cancelCustomServerAuthentication: (request: AuthenticateCustomServerRequest) => Promise<void>
  setCustomServerEnabled: (id: string, enabled: boolean) => Promise<void>
  removeCustomServer: (id: string) => Promise<void>
  enqueueApproval: (request: ConnectorApprovalRequest) => void
  respondApproval: (id: string, decision: ApprovalDecision) => Promise<void>
}

type SettingsConnectorsCommands = Pick<
  Window['api']['settings'],
  | 'listConnectors'
  | 'setConnectorEnabled'
  | 'setConnectorsEnabled'
  | 'setConnectorAutoAllow'
  | 'setToolPermission'
  | 'setNcbiCredentials'
  | 'addCustomServer'
  | 'updateCustomServer'
  | 'authenticateCustomServer'
  | 'cancelCustomServerAuthentication'
  | 'setCustomServerEnabled'
  | 'removeCustomServer'
  | 'respondConnectorApproval'
>

type SettingsConnectorsSliceOptions = {
  setState: (
    patch:
      | Partial<SettingsConnectorsState>
      | ((state: SettingsConnectorsState) => Partial<SettingsConnectorsState>)
  ) => void
  getCommands: () => SettingsConnectorsCommands
}

export const createInitialSettingsConnectorsState = (): SettingsConnectorsState => ({
  connectors: [],
  customServers: [],
  pendingApprovals: [],
  ncbi: { hasApiKey: false }
})

// Owns the renderer projection for Connector catalogs, custom servers, NCBI credentials, and the
// approval queue. Main remains authoritative for every catalog mutation and trust decision.
export const createSettingsConnectorsSlice = ({
  setState,
  getCommands
}: SettingsConnectorsSliceOptions): SettingsConnectorsActions => {
  const reconcile = async (command: () => Promise<SettingsConnectorsProjection>): Promise<void> => {
    setState(await command())
  }

  return {
    loadConnectors: () => reconcile(() => getCommands().listConnectors()),
    setConnectorEnabled: async (id, enabled) => {
      setState((state) => ({
        connectors: state.connectors.map((connector) =>
          connector.id === id ? { ...connector, enabled } : connector
        )
      }))
      await reconcile(() => getCommands().setConnectorEnabled({ id, enabled }))
    },
    // A bulk change applies the same optimistic update to every listed connector, then reconciles against
    // the projection the app returns and hands the per-connector outcomes back to the caller — so the panel
    // can say which ones changed and which failed instead of reporting the batch as one success.
    setConnectorsEnabled: async (ids, enabled) => {
      const listed = new Set(ids)
      setState((state) => ({
        connectors: state.connectors.map((connector) =>
          listed.has(connector.id) ? { ...connector, enabled } : connector
        )
      }))
      const result = await getCommands().setConnectorsEnabled({
        items: ids.map((id) => ({ id, enabled }))
      })
      setState(result.snapshot)
      return result.results
    },
    setConnectorAutoAllow: async (id, autoAllow) => {
      setState((state) => ({
        connectors: state.connectors.map((connector) =>
          connector.id === id ? { ...connector, autoAllow } : connector
        )
      }))
      await reconcile(() => getCommands().setConnectorAutoAllow({ id, autoAllow }))
    },
    setToolPermission: async (toolId, permission) =>
      getCommands().setToolPermission({ toolId, permission }),
    setNcbiCredentials: (request) => reconcile(() => getCommands().setNcbiCredentials(request)),
    addCustomServer: (request) => reconcile(() => getCommands().addCustomServer(request)),
    updateCustomServer: (request) => reconcile(() => getCommands().updateCustomServer(request)),
    authenticateCustomServer: async (request) => {
      try {
        await reconcile(() => getCommands().authenticateCustomServer(request))
      } catch (error) {
        // Authentication can invalidate stale tokens before failing. Refresh the projection so the
        // connector does not remain visibly "Connected" after main has cleared its credentials.
        await reconcile(() => getCommands().listConnectors()).catch(() => undefined)
        throw error
      }
    },
    cancelCustomServerAuthentication: (request) =>
      getCommands().cancelCustomServerAuthentication(request),
    setCustomServerEnabled: async (id, enabled) => {
      setState((state) => ({
        customServers: state.customServers.map((server) =>
          server.id === id ? { ...server, enabled } : server
        )
      }))
      await reconcile(() => getCommands().setCustomServerEnabled({ id, enabled }))
    },
    removeCustomServer: (id) => reconcile(() => getCommands().removeCustomServer({ id })),
    enqueueApproval: (request) => {
      setState((state) =>
        state.pendingApprovals.some(({ id }) => id === request.id)
          ? state
          : { pendingApprovals: [...state.pendingApprovals, request] }
      )
    },
    respondApproval: async (id, decision) => {
      setState((state) => ({
        pendingApprovals: state.pendingApprovals.filter((request) => request.id !== id)
      }))
      await getCommands().respondConnectorApproval({ id, decision })
    }
  }
}
