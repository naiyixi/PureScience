// `external-mcp` is an outside MCP client (a desktop assistant, a script) talking to this app through
// `purescience mcp`. It is deliberately NOT `human`: nothing outside this process may satisfy an
// approval, and the read-only slice it can reach today never crosses the permission gate at all.
export type CallerSurface = 'electron' | 'web' | 'task' | 'external-mcp'
export type CallerLocation = 'local' | 'remote'
export type CallerPrincipalKind = 'human' | 'automation' | 'agent-session' | 'external-mcp'
export type CallerActionOrigin = 'human' | 'automation' | 'agent-session' | 'external-mcp'
export type CallerAuthority = 'manage-remote-pairing' | 'satisfy-approval'

export type CallerContext = Readonly<{
  clientId: string
  lifecycleClientId: string
  leaseId: string
  surface: CallerSurface
  location: CallerLocation
  principalKind: CallerPrincipalKind
  actionOrigin: CallerActionOrigin
  authorities: readonly CallerAuthority[]
  isAuthorizationCurrent: () => boolean
}>

type CreateCallerContextInput = Omit<CallerContext, 'authorities' | 'isAuthorizationCurrent'> & {
  authorities?: readonly CallerAuthority[]
  isAuthorizationCurrent?: () => boolean
}

type CreateWebCallerContextOptions = Partial<
  Pick<CallerContext, 'location' | 'principalKind' | 'actionOrigin'>
> & {
  authorities?: readonly CallerAuthority[]
  isAuthorizationCurrent?: () => boolean
}

type CreateTaskCallerContextOptions = Partial<Pick<CallerContext, 'location'>> & {
  isAuthorizationCurrent?: () => boolean
  // A headless service has no window to click. The authenticated approval route builds its command
  // context with this authority so a human at a terminal can answer a card — the capability is named
  // and auditable instead of relabelling automation as human.
  satisfyApproval?: boolean
}

const alwaysCurrent = (): boolean => true

const createCallerContext = (input: CreateCallerContextInput): CallerContext =>
  Object.freeze({
    ...input,
    authorities: Object.freeze([...new Set(input.authorities ?? [])]),
    isAuthorizationCurrent: input.isAuthorizationCurrent ?? alwaysCurrent
  })

const createElectronCallerContext = (senderId: number): CallerContext =>
  createCallerContext({
    clientId: String(senderId),
    lifecycleClientId: `electron:${senderId}`,
    leaseId: `electron:${senderId}`,
    surface: 'electron',
    location: 'local',
    principalKind: 'human',
    actionOrigin: 'human'
  })

const createWebCallerContext = (
  clientId: string,
  options: CreateWebCallerContextOptions = {}
): CallerContext =>
  createCallerContext({
    clientId,
    lifecycleClientId: `web:${clientId}`,
    leaseId: clientId,
    surface: 'web',
    location: options.location ?? 'local',
    principalKind: options.principalKind ?? 'human',
    actionOrigin: options.actionOrigin ?? 'human',
    authorities: options.authorities,
    isAuthorizationCurrent: options.isAuthorizationCurrent
  })

const createTaskCallerContext = (options: CreateTaskCallerContextOptions = {}): CallerContext =>
  createCallerContext({
    clientId: 'headless-task-api',
    lifecycleClientId: 'web:headless-task-api',
    leaseId: 'headless-task-api',
    surface: 'task',
    location: options.location ?? 'local',
    principalKind: 'automation',
    actionOrigin: 'automation',
    authorities: options.satisfyApproval ? (['satisfy-approval'] as const) : undefined,
    isAuthorizationCurrent: options.isAuthorizationCurrent
  })

// An outside MCP client. No authorities are granted by construction: it cannot satisfy an approval, and
// `canSatisfyHumanApproval` is false for it because both the principal and the action origin are
// `external-mcp`. `clientId` is the transport's per-connection id so two clients keep separate leases.
const createExternalMcpCallerContext = (clientId: string): CallerContext =>
  createCallerContext({
    clientId,
    lifecycleClientId: `external-mcp:${clientId}`,
    leaseId: `external-mcp:${clientId}`,
    surface: 'external-mcp',
    location: 'local',
    principalKind: 'external-mcp',
    actionOrigin: 'external-mcp'
  })

const hasCallerAuthority = (context: CallerContext, authority: CallerAuthority): boolean =>
  context.isAuthorizationCurrent() && context.authorities.includes(authority)

const canSatisfyHumanApproval = (context: CallerContext): boolean =>
  context.isAuthorizationCurrent() &&
  ((context.principalKind === 'human' && context.actionOrigin === 'human') ||
    hasCallerAuthority(context, 'satisfy-approval'))

export type ClientLease = Readonly<{
  clientId: string
  release: () => void
}>

type CallerEvent = {
  sender: {
    id: number
  }
}

const nativeCallerContexts = new WeakMap<object, CallerContext>()

const callerContextForEvent = (event: CallerEvent): CallerContext => {
  if (event.sender.id <= 0) throw new Error('Electron caller sender id must be positive.')
  const sender = event.sender as object
  const existing = nativeCallerContexts.get(sender)
  if (existing) return existing
  const context = createElectronCallerContext(event.sender.id)
  nativeCallerContexts.set(sender, context)
  return context
}

export class ClientLeaseRegistry {
  private readonly leasesByClient = new Map<string, Set<symbol>>()
  private disposed = false

  constructor(private readonly releaseClient: (clientId: string) => void) {}

  acquire(clientId: string): ClientLease {
    if (this.disposed) throw new Error('Client lease registry is disposed.')
    const token = Symbol(clientId)
    const leases = this.leasesByClient.get(clientId) ?? new Set<symbol>()
    leases.add(token)
    this.leasesByClient.set(clientId, leases)
    let released = false

    return Object.freeze({
      clientId,
      release: () => {
        if (released) return
        released = true
        const active = this.leasesByClient.get(clientId)
        if (!active?.delete(token) || active.size > 0) return
        this.leasesByClient.delete(clientId)
        this.releaseClient(clientId)
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const clientIds = [...this.leasesByClient.keys()]
    this.leasesByClient.clear()
    const failures: unknown[] = []
    for (const clientId of clientIds) {
      try {
        this.releaseClient(clientId)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Client lease cleanup failed.')
  }
}

export {
  callerContextForEvent,
  canSatisfyHumanApproval,
  createCallerContext,
  createElectronCallerContext,
  createExternalMcpCallerContext,
  createTaskCallerContext,
  createWebCallerContext,
  hasCallerAuthority
}
