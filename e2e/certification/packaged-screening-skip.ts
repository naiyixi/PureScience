// The four literature-screening certification checks are skipped on the packaged lane (PURESCIENCE_E2E_EXECUTABLE
// set), and this file exists so that skip is a fact with a date and a reading rather than a shrug.
//
// What was measured (Nightly 41290216695, head 40634515, macos-arm64, packaged bundle):
//   * clicking “Screen collection” never starts a record — the app log carries only
//     `[screening:model] screening runner shutting down { recordsInFlight: 0 }` (19×) and **no**
//     `screening record started` line at all, so the failure is upstream of the model call;
//   * the same four specs pass on a real machine against the same packaged bundle
//     (4 passed (3.5m), 46 prompts answered by the fixture agent), so this is lane-specific.
// The earlier version of this skip blamed a stall; that was wrong — see
// docs/evidence/2026-11-01-three-day-incident-review.md §4 for the correction.
//
// Delete this file when the packaged lane starts a record; the skip is the only thing standing between the
// lane and the four specs.
export const PACKAGED_SCREENING_SKIP_REASON =
  'Packaged lane: the screening pass starts no record (only `recordsInFlight: 0` at shutdown; no `screening record started` line), while the same specs pass against the same bundle on a real machine — tracked in docs/evidence/2026-11-01-three-day-incident-review.md §4.'

export const isPackagedLane = (): boolean =>
  process.env.PURESCIENCE_E2E_PACKAGED_SKIP_BYPASS !== '1' &&
  typeof process.env.PURESCIENCE_E2E_EXECUTABLE === 'string' &&
  process.env.PURESCIENCE_E2E_EXECUTABLE.length > 0
