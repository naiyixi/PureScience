import { describe, expect, it } from 'vitest'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { hasLegacyKeyRefs } from './legacy-key-refs'
import type { StoredProvider, StoredSettings } from './types'

// The predicate that decides whether a settings read is allowed to touch the OS secret store. Getting
// this wrong in the "true" direction is a wasted keychain round-trip; getting it wrong in the "false"
// direction leaves a `plain:` key on disk forever, so both sides are pinned here.

const base = (overrides: Partial<StoredSettings> = {}): StoredSettings => ({
  version: SETTINGS_FILE_VERSION,
  providers: [],
  ...overrides
})

const provider = (keyRef: string | undefined): StoredProvider =>
  ({ id: 'p1', type: 'official', keyRef }) as StoredProvider

describe('hasLegacyKeyRefs', () => {
  it('is false for a document whose keys are already migrated', () => {
    expect(hasLegacyKeyRefs(base({ providers: [provider('enc:v1:ciphertext')] }))).toBe(false)
  })

  it('is false for a document with no keys at all', () => {
    expect(hasLegacyKeyRefs(base())).toBe(false)
    expect(hasLegacyKeyRefs(base({ providers: [provider(undefined)] }))).toBe(false)
  })

  it('is true when any provider still carries a plain reference', () => {
    expect(
      hasLegacyKeyRefs(
        base({ providers: [provider('enc:v1:ciphertext'), provider('plain:c2stbGV5')] })
      )
    ).toBe(true)
  })

  it('is true when the connector credentials still carry a plain reference', () => {
    expect(
      hasLegacyKeyRefs(
        base({ connectors: { ncbiApiKeyRef: 'plain:bmNiaQ==' } as StoredSettings['connectors'] })
      )
    ).toBe(true)
  })

  it('is false when only non-key connector settings are present', () => {
    expect(
      hasLegacyKeyRefs(
        base({ connectors: { ncbiApiKeyRef: 'enc:v1:ciphertext' } as StoredSettings['connectors'] })
      )
    ).toBe(false)
  })
})
