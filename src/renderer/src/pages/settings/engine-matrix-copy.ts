// Copy keys for the engine matrix. They live in their own module rather than beside the component
// for two reasons: the component file then exports only a component (a Fast Refresh constraint the
// linter enforces), and `engine-matrix-copy.test.ts` can assert every key resolves in all nine
// dictionaries without importing the React tree.
//
// These maps are the single source of the keys. They are typed on the shared unions (availability
// status, weight-gate state, output kind), so adding a union member fails the build here instead of
// reaching the screen as a raw `engines.…` string.
import type { TranslationKey } from '@/i18n'

import type { EngineAvailability, EngineOutputKind } from '../../../../shared/engine-catalog'
import type { EngineWeightGate } from '../../../../shared/engine-weights'

export const STATUS_KEYS: Record<EngineAvailability['status'], TranslationKey> = {
  ready: 'engines.status.ready',
  'needs-consent': 'engines.status.needsConsent',
  'needs-host': 'engines.status.needsHost',
  unavailable: 'engines.status.unavailable'
}

/** Shown instead of the availability status when the weight gate blocks the engine: "needs your
 *  approval" would promise that approving enables it, which no approval can do without a checksum. */
export const BLOCKED_BY_WEIGHTS_KEY: TranslationKey = 'engines.status.weightsUnavailable'

export const WEIGHT_KEYS: Record<EngineWeightGate['state'], TranslationKey> = {
  'not-needed': 'engines.weights.notNeeded',
  unpublished: 'engines.weights.unpublished',
  'awaiting-consent': 'engines.weights.awaitingConsent',
  ready: 'engines.weights.ready'
}

export const OUTPUT_KEYS: Record<EngineOutputKind, TranslationKey> = {
  measured: 'engines.output.measured',
  lookup: 'engines.output.lookup',
  predicted: 'engines.output.predicted'
}
