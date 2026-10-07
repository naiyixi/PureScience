import type { RoCrateValidationReport } from './ro-crate'

// The desktop wire contract for checking a crate this app did NOT write — the read-only other half of the
// RO-Crate export.
//
// The rules live in `./ro-crate` (`validateRoCrate`) and the byte reader in `src/main/ro-crate/import.ts`;
// this module only names what a window may ask for and what it gets back. Two rules shaped it:
//   · a refusal is a CODE, not prose — the reader's interface language is the renderer's business — and the
//     three ways a path fails BEFORE any rule is judged are kept apart from the report of a crate that was
//     judged. Collapsing them would hide which rules failed, which is the whole point of a report;
//   · a report always carries every assertion it made, passed or failed, so the window can name the ones
//     that were not met instead of reducing the answer to "ok / not ok".
//
// What a passing report means is deliberately narrow, and the surface says so: every assertion this app
// knows how to make held. It is NOT a statement that the crate is scientifically right.
export const RO_CRATE_INSPECT_CHANNEL = 'ro-crate:inspect-external'

/** The ways a path fails before any RO-Crate rule is judged. */
export const EXTERNAL_RO_CRATE_REFUSALS = ['no-metadata-file', 'unreadable', 'unparseable'] as const

export type ExternalRoCrateRefusal = (typeof EXTERNAL_RO_CRATE_REFUSALS)[number]

/** What a window asks for. The path is chosen by the window; this module never invents one. */
export type RoCrateInspectRequest = {
  /** Folder that holds the crate's metadata document. */
  cratePath: string
}

/** The reader's own answer, before the channel wraps it: a refusal, or the report of a judged crate. */
export type ExternalRoCrateInspection =
  | { ok: true; metadataPath: string; report: RoCrateValidationReport }
  | { ok: false; reason: ExternalRoCrateRefusal; detail: string }

/**
 * The channel's answer. `ok: true` carries the crate that was actually read (so the window can show which
 * folder and which document produced the report) plus every assertion; `ok: false` names the refusal.
 */
export type RoCrateInspectResult =
  | {
      ok: true
      cratePath: string
      metadataPath: string
      report: RoCrateValidationReport
    }
  | { ok: false; error: ExternalRoCrateRefusal; detail?: string }
