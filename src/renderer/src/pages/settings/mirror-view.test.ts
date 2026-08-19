import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { isMirrorConfigured, mirrorStatusText, MIRROR_HELP_URL } from './mirror-view'

// The English dictionary is the byte-exact fallback the real app uses without a LanguageProvider.
const enT = (key: string): string => en[key as keyof typeof en] ?? key

describe('isMirrorConfigured', () => {
  it('is false for undefined or all-empty', () => {
    expect(isMirrorConfigured(undefined)).toBe(false)
    expect(isMirrorConfigured({})).toBe(false)
  })
  it('is true when any field is set', () => {
    expect(isMirrorConfigured({ pypiIndex: 'https://p/simple' })).toBe(true)
  })
})

describe('mirrorStatusText', () => {
  it('shows the default public-hosts message when unconfigured', () => {
    expect(mirrorStatusText(undefined, enT)).toBe(
      'Not configured — packages come from the public hosts (conda.anaconda.org, pypi.org)'
    )
  })
  it('summarizes the configured hosts when set', () => {
    expect(
      mirrorStatusText({ condaChannel: 'https://c', pypiIndex: 'https://p/simple' }, enT)
    ).toContain('https://c')
  })
})

describe('MIRROR_HELP_URL', () => {
  it('is a non-empty URL string', () => {
    expect(MIRROR_HELP_URL.length).toBeGreaterThan(0)
  })
})
