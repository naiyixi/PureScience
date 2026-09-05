// In-memory registry mapping sessionId → delegation enabled (absent = enabled).
// Populated from the session-persistence rebase path whenever a session saves its
// delegationEnabled flag, so main-process enforcement (delegate_tasks gate) never
// needs a new IPC channel: the renderer's per-session save already flows here.
// Default is ENABLED — only sessions that explicitly disabled delegation are tracked.
export class DelegationRegistry {
  private readonly disabledSessions = new Set<string>()

  isEnabled(sessionId: string): boolean {
    return !this.disabledSessions.has(sessionId)
  }

  setEnabled(sessionId: string, enabled: boolean): void {
    if (enabled) {
      this.disabledSessions.delete(sessionId)
    } else {
      this.disabledSessions.add(sessionId)
    }
  }

  clear(sessionId: string): void {
    this.disabledSessions.delete(sessionId)
  }
}

export const delegationRegistry = new DelegationRegistry()
