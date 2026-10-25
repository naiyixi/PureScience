// Does this settings document still carry a pre-encryption key reference?
//
// Why this is a separate, pure check: the migration that rewrites those references is the ONLY part of a
// settings read that touches the OS secret store, and that touch is not cheap on every machine —
// `encryption-available` has been measured at 10,311 / 16,758 / 56,769 / 635,082 ms across launches on
// this host, while the same pass spent under 40 ms on providers and connectors. Asking the keychain
// "can you be used?" in order to decide "is there anything to migrate?" is the whole cost, paid on every
// read (startup, the settings view, the permission-grant registry) even when the answer is "nothing".
//
// A document answers that question by itself: a legacy reference is a `plain:` prefixed string. So the
// keychain is now consulted only when such a reference actually exists — i.e. on the first launch after
// an upgrade, which is the one time the migration can do anything.

import type { StoredSettings } from './types'

/** Prefix of an unmigrated (base64, not safeStorage) key reference. Matches `crypto.ts`. */
export const PLAIN_REF_PREFIX = 'plain:'

const isPlainRef = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith(PLAIN_REF_PREFIX)

export const hasLegacyKeyRefs = (settings: StoredSettings): boolean => {
  if (settings.providers.some((provider) => isPlainRef(provider.keyRef))) return true
  return isPlainRef(settings.connectors?.ncbiApiKeyRef)
}
