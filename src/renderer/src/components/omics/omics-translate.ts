import type { Translate } from '@/i18n'
import type { OmicsTranslate } from '../../../../shared/omics-preview'

/**
 * The shared omics formatters only need a key-to-sentence lookup, and they live in src/shared where
 * renderer types must not reach. This adapter is the one place that bridges the two: the dictionary
 * stays type-checked here, and the shared signature stays free of renderer imports.
 */
export const asOmicsTranslate =
  (t: Translate): OmicsTranslate =>
  (key) =>
    t(key as Parameters<Translate>[0])
