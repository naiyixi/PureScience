// A cheap "a session was written" signal, for readers that would otherwise re-read everything.
//
// Search is the reader that needs it: answering a query used to mean parsing every session file on disk,
// which cost over a second on a real corpus. Writes are the only thing that can change the answer, so the
// durable repository bumps this counter and the reader can tell, with no I/O at all, whether its view is
// still current.

let revision = 0

export const bumpSessionRevision = (): number => {
  revision += 1
  return revision
}

export const getSessionRevision = (): number => revision

// Tests use this to start from a known state; production code never needs to.
export const resetSessionRevision = (): void => {
  revision = 0
}
