// Whether a session was actually told about its capability gaps.
//
// This exists because three separate ablation attempts failed the same way: the injection never fired,
// the scores looked flat, and the only way to find out was to grep a log file after the fact. A log is
// not evidence a benchmark can check — so the app keeps a per-session tally and the evidence API
// reports it, which lets the runner refuse an arm whose manipulation never happened.

export type CapabilityNoticeTally = {
  /** Turns where a gap block actually reached the prompt content. */
  injectedTurns: number
  /** Turns evaluated (injected or not), so "never injected" is distinguishable from "never asked". */
  turns: number
  /** Lines in the most recent block; 0 when that turn had no gaps. */
  lastLines: number
}

const tallies = new Map<string, CapabilityNoticeTally>()

export const recordCapabilityNotice = (
  sessionId: string,
  outcome: { injected: boolean; lines: number }
): void => {
  const current = tallies.get(sessionId) ?? { injectedTurns: 0, turns: 0, lastLines: 0 }
  tallies.set(sessionId, {
    injectedTurns: current.injectedTurns + (outcome.injected ? 1 : 0),
    turns: current.turns + 1,
    lastLines: outcome.lines
  })
}

export const readCapabilityNoticeTally = (sessionId: string): CapabilityNoticeTally | null =>
  tallies.get(sessionId) ?? null

/** Test seam: the tally is process state, and a test must not inherit another test's turns. */
export const resetCapabilityNoticeTallies = (): void => {
  tallies.clear()
}
