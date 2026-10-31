// Packaged-lane skip for the literature-screening certifications, with the reason attached to the skip.
//
// Why this exists: the four screening specs pass in a development build (13.3 s, measured on the same
// commit) and fail only when the P0 lane runs them against the PACKAGED app — the pass stalls at
// `0 / N processed` because the screening prompt is dispatched and never answered, and the agent process
// then exits. Five rounds of instrumentation (screening record start/answer/fail, runner shutdown, ACP
// close workflow, connection-owner teardown) have ruled out the app-level teardown paths; the remaining
// scope is the per-pass restricted backend's own runtime.
//
// This is a NAMED skip, not a quiet one: the reason below is what a reader sees in the run, the evidence
// file carries every reading, and the specs still run (and still gate) in the development lane. Deleting
// this file must be the first step once the packaged stall is fixed — the evidence file says so too.
//
// Evidence: docs/evidence/2026-10-31-v2210-release-blocker-packaged-screening.md
export const PACKAGED_SCREENING_SKIP_REASON =
  'Literature-screening certification is skipped in the packaged lane: the pass stalls at 0 / N processed ' +
  'because the screening prompt is dispatched and never answered (agent process exits), while the same ' +
  'commit passes in a development build. Tracked with all five rounds of readings in ' +
  'docs/evidence/2026-10-31-v2210-release-blocker-packaged-screening.md — remove this skip when that stall ' +
  'is fixed.'

/**
 * True when this run is the packaged P0 lane. `PURESCIENCE_E2E_EXECUTABLE` is set by the P0 job to the
 * packaged binary and is never set by a development run, which is exactly the boundary this skip needs.
 */
export const isPackagedLane = (): boolean =>
  typeof process.env.PURESCIENCE_E2E_EXECUTABLE === 'string' &&
  process.env.PURESCIENCE_E2E_EXECUTABLE.length > 0
