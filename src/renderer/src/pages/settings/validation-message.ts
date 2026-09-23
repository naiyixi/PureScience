import type { Translate, TranslationKey } from '@/i18n'

import type { ValidateProviderResult, ValidationCategory } from '../../../../shared/settings'

// Maps a validation category to an actionable, user-facing message. Centralized so the wizard and the
// settings page phrase failures identically.
// Keys, not sentences: this module has no i18n hook, so it hands the renderer a key and the renderer
// translates. `describeValidation` therefore takes the translate function as its second argument.
const CATEGORY_MESSAGE_KEYS: Record<ValidationCategory, string> = {
  ok: 'settings.validationOk',
  network: 'settings.validationNetwork',
  auth: 'settings.validationAuth',
  'model-not-found': 'settings.validationModelNotFound',
  'bad-url': 'settings.validationBadUrl',
  // Refused before anything was sent: the credential would have travelled in the clear. The escape hatch
  // is that provider's own "allow plaintext endpoint" switch, which records the decision.
  'insecure-endpoint': 'settings.validationInsecureEndpoint',
  timeout: 'settings.validationTimeout',
  incompatible: 'settings.validationIncompatible',
  'server-error': 'settings.validationServerError',
  unknown: 'settings.validationUnknown'
}

// Categories whose generic text benefits from the specific error/probe message (a timeout or network
// failure). Auth/model/bad-url already carry actionable text.
const MESSAGE_CATEGORIES = new Set<ValidationCategory>([
  'network',
  'timeout',
  'server-error',
  'unknown'
])

// Produces the message to show for a validation result, appending a specific server/probe message when
// the category is generic and an HTTP status when one is available.
const describeValidation = (result: ValidateProviderResult, t: Translate): string => {
  const base = t(CATEGORY_MESSAGE_KEYS[result.category] as TranslationKey)

  // Some gateways return their own actionable auth text; prefer it over the generic HTTP 401/403 copy.
  if (result.category === 'auth' && result.message) {
    return result.message
  }

  // An incompatible pairing carries the specific route mismatch (which API format the framework needs
  // vs. what this provider speaks); surface it instead of the generic fallback.
  if (result.category === 'incompatible' && result.message) {
    return result.message
  }

  // A gateway that rejected the probe with its own error text (e.g. "Insufficient Balance" on a
  // billing 402) has already told us the reason — surface it instead of the generic "unknown" copy.
  if (result.category === 'unknown' && result.message) {
    return result.status ? `${result.message} (HTTP ${result.status})` : result.message
  }

  if (result.message && MESSAGE_CATEGORIES.has(result.category)) {
    return `${base} (${result.message})`
  }

  if (result.status) {
    return `${base} (HTTP ${result.status})`
  }

  return base
}

export { CATEGORY_MESSAGE_KEYS, describeValidation }
