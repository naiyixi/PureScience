import type {
  HandoffEventsRequest,
  HandoffLifecycleChange,
  HandoffLifecycleEvent,
  HandoffLifecycleEventSource,
  HandoffRetryRequest
} from '../../../../shared/handoff-lifecycle'

// The lifecycle's own face (window.api.handoff). It already speaks HandoffLifecycleEvent, so nothing
// here translates the legacy specialist shape any more.
type HandoffLifecycleApi = {
  list(request: HandoffEventsRequest): Promise<readonly HandoffLifecycleEvent[]>
  retry(request: HandoffRetryRequest): Promise<void>
  onChanged(listener: (change: HandoffLifecycleChange) => void): () => void
}

// `useSyncExternalStore` requires an unchanged snapshot to keep the same reference. Sessions with
// no handoffs are common, so they must share this empty snapshot instead of allocating `[]` per read.
const EMPTY_EVENTS: readonly HandoffLifecycleEvent[] = []

const sameEvents = (
  left: readonly HandoffLifecycleEvent[],
  right: readonly HandoffLifecycleEvent[]
): boolean =>
  left.length === right.length &&
  left.every(
    (event, index) =>
      event.id === right[index]?.id &&
      event.sequence === right[index]?.sequence &&
      event.phase === right[index]?.phase
  )

// Retained IPC snapshots close the gap before subscription; changed events keep the transcript live.
// The only renderer command is a retry intent. Main remains responsible for validating it.
class IpcHandoffLifecycleClient implements HandoffLifecycleEventSource {
  private readonly eventsBySession = new Map<string, readonly HandoffLifecycleEvent[]>()
  private readonly listeners = new Set<() => void>()
  private stopChangedListener: (() => void) | undefined

  constructor(private readonly getApi: () => HandoffLifecycleApi | undefined) {}

  getEvents(sessionId: string): readonly HandoffLifecycleEvent[] {
    return this.eventsBySession.get(sessionId) ?? EMPTY_EVENTS
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.ensureChangedListener()

    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.stopChangedListener?.()
        this.stopChangedListener = undefined
      }
    }
  }

  async load(sessionId: string): Promise<void> {
    const api = this.getApi()
    if (!api) return

    const retained = await api.list({ sessionId })
    this.merge(sessionId, retained)
  }

  async retry(request: HandoffRetryRequest): Promise<void> {
    const api = this.getApi()
    if (!api) throw new Error('Handoff lifecycle API is unavailable')
    // No client-side lookup: the coordinator resolves the originating turn itself and is the only side
    // that validates a retry intent.
    await api.retry({ sessionId: request.sessionId, originatingTurnId: request.originatingTurnId })
  }

  private ensureChangedListener(): void {
    if (this.stopChangedListener) return
    const api = this.getApi()
    if (!api) return
    this.stopChangedListener = api.onChanged((change) => {
      if (change.kind === 'remove') {
        for (const eventId of change.eventIds) this.remove(change.sessionId, eventId)
        return
      }
      this.merge(change.event.sessionId, [change.event])
    })
  }

  private merge(sessionId: string, incoming: readonly HandoffLifecycleEvent[]): void {
    const current = this.getEvents(sessionId)
    const byId = new Map(current.map((event) => [event.id, event]))
    for (const event of incoming) byId.set(event.id, event)
    const next = Array.from(byId.values()).sort((left, right) => left.sequence - right.sequence)
    if (sameEvents(current, next)) return

    this.eventsBySession.set(sessionId, next)
    for (const listener of this.listeners) listener()
  }

  private remove(sessionId: string, id: string): void {
    const current = this.getEvents(sessionId)
    const next = current.filter((event) => event.id !== id)
    if (sameEvents(current, next)) return
    this.eventsBySession.set(sessionId, next)
    for (const listener of this.listeners) listener()
  }
}

const workspaceHandoffLifecycleClient = new IpcHandoffLifecycleClient(() => window.api?.handoff)

export { IpcHandoffLifecycleClient, workspaceHandoffLifecycleClient }
