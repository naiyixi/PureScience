import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'

import { MAIN_MESSAGE_KEYS, localizeMainMessage } from './main-message-catalog'

const translator = (key: string): string => en[key as keyof typeof en] ?? key

describe('main message catalog', () => {
  it('maps every exact sentence the interface prints verbatim', () => {
    for (const [message, key] of Object.entries(MAIN_MESSAGE_KEYS)) {
      expect(localizeMainMessage(translator, message), message).toBe(translator(key))
    }
  })

  it('every key it names exists in the dictionary', () => {
    const missing = Object.entries(MAIN_MESSAGE_KEYS)
      .filter(([, key]) => !(key in en))
      .map(([message, key]) => `${key} (for ${message.slice(0, 40)}…)`)
    expect(missing).toEqual([])
  })

  it('fills the two composed sentences from what main sends', () => {
    expect(
      localizeMainMessage(
        translator,
        "That interpreter can't be used as a notebook runtime: Python 3.9 is not on PATH"
      )
    ).toBe("That interpreter can't be used as a notebook runtime: Python 3.9 is not on PATH")

    expect(
      localizeMainMessage(
        translator,
        'Installing packages into your own python environment is not authorized. Turn on "Allow package install" for this runtime in Settings → Runtimes first (installs go into your own environment, not the app-managed storage).'
      )
    ).toContain('Installing packages into your own python environment is not authorized.')
  })

  it('leaves an unrecognised message exactly as it arrived', () => {
    const unknown = 'EACCES: permission denied, open /tmp/x'
    expect(localizeMainMessage(translator, unknown)).toBe(unknown)
  })
})
