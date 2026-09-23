// The picking session lives in src/shared, which the main process also imports, so it cannot
// reach the renderer dictionary. It throws FigureDigitizationError with an i18n key attached and
// this guard is the single place that decides which keys the renderer is allowed to translate —
// an unknown key falls through to the raw message rather than rendering a key at the user.
import type { TranslationKey } from '@/i18n'

const FIGURE_ERROR_KEYS = [
  'figure.errorFiniteAnchor',
  'figure.errorDuplicateAnchor',
  'figure.errorAxisComplete',
  'figure.errorNeedXAnchors',
  'figure.errorCalibrationIncomplete',
  'figure.errorPointFinite',
  'figure.errorAnchorsRequired'
] as const

export const isFigureErrorKey = (key: string | undefined): key is TranslationKey =>
  typeof key === 'string' && (FIGURE_ERROR_KEYS as readonly string[]).includes(key)
