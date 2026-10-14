import type { NotebookMutationKind, NotebookStaleReasonKind } from './run-alias-lineage'
import { ALIAS_LINEAGE_RECIPE_VERSION, computeNotebookStaleReasons } from './run-alias-lineage'
import type { AliasLineageRun } from './run-alias-lineage'

// B2-3: the alias-level lineage of the run that produced one artifact Version, projected for the Version's
// provenance panel. The analysis itself is not repeated here — it is the notebook module's own
// `computeNotebookStaleReasons`, the same engine the notebook pane shows, so the two surfaces cannot drift
// apart on what a reason MEANS. What this module adds is the scoping: a Version is produced by ONE run, so
// only the reasons whose producer is that run are its lineage — the values that run wrote and that a LATER
// run changed, by name-rewrite, in place, or through an alias chain.
//
// Every row carries the producer run's content hash and the recipe version, so a reader holding the run
// record can recompute the row instead of trusting this projection.

/** One value the producing run wrote that a later run changed. */
export type ArtifactAliasLineageRow = {
  /** The base name the producing run wrote. */
  variable: string
  /** The name the later run used at the change site (=== `variable` unless an alias carried it). */
  via: string
  /** Names from `variable` to `via`, one hop per plain alias binding. Empty for a direct change. */
  aliasChain: string[]
  kind: NotebookStaleReasonKind
  /** The run that produced the value — this Version's producing run. */
  producerRunId: string
  /** sha256 of that run's source, from its own persisted review; 'not-recorded' if absent. */
  producerContentHash: string | 'not-recorded'
  /** The later completed run that changed it. */
  laterRunId: string
  /** How the object changed. Absent for a plain rewrite, which has no site in this sense. */
  mutation?: { kind: NotebookMutationKind; line: number; excerpt: string }
}

export type ArtifactAliasLineage =
  | {
      state: 'available'
      /** The published recipe a reader recomputes these rows with. */
      recipeVersion: string
      /** The run this Version was produced by. */
      producerRunId: string
      rows: ArtifactAliasLineageRow[]
    }
  | {
      state: 'unavailable'
      /**
       * `not-loaded` — this read did not ask for the section. `producer-not-recorded` — the Version names
       * no producing run, so nothing could be scoped to one. `runs-not-recorded` — the session holds no
       * run document. `runs-unreadable` — the document exists but could not be read. None of these means
       * "the dependencies are clean": each names why the question could not be answered.
       */
      reason: 'not-loaded' | 'producer-not-recorded' | 'runs-not-recorded' | 'runs-unreadable'
    }

export const buildArtifactAliasLineage = (input: {
  producerRunId: string
  runs: readonly AliasLineageRun[]
}): ArtifactAliasLineage => {
  const rows: ArtifactAliasLineageRow[] = computeNotebookStaleReasons(input.runs)
    .filter((reason) => reason.producerRunId === input.producerRunId)
    .map((reason) => ({
      variable: reason.variable,
      via: reason.via,
      aliasChain: [...reason.aliasChain],
      kind: reason.kind,
      producerRunId: reason.producerRunId,
      producerContentHash: reason.producerContentHash,
      laterRunId: reason.laterRunId,
      ...(reason.mutation
        ? {
            mutation: {
              kind: reason.mutation.kind,
              line: reason.mutation.line,
              excerpt: reason.mutation.excerpt
            }
          }
        : {})
    }))

  return {
    state: 'available',
    recipeVersion: ALIAS_LINEAGE_RECIPE_VERSION,
    producerRunId: input.producerRunId,
    rows
  }
}
