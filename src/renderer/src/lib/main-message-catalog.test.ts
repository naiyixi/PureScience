import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'

import {
  MAIN_MESSAGE_KEYS,
  MAIN_MESSAGE_TEMPLATES,
  localizeMainMessage,
  unwrapIpcEnvelope
} from './main-message-catalog'

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

  it('every composed-sentence key exists in the dictionary too', () => {
    // A template whose key is misspelled falls through the translator and puts the KEY on screen, which
    // no other assertion here would catch — the exact-map test above only walks MAIN_MESSAGE_KEYS.
    const missing = MAIN_MESSAGE_TEMPLATES.filter((template) => !(template.key in en)).map(
      (template) => template.key
    )
    expect(missing).toEqual([])
  })

  it('fills a connector name/ID conflict from the quoted value main sends', () => {
    const cases: Array<[string, string]> = [
      [
        'Connector name "arxiv" is reserved by a built-in connector',
        'mainMessage.connectorNameReserved'
      ],
      ['A custom connector named "My Tools" already exists', 'mainMessage.connectorNameExists'],
      [
        'Connector name "Web" conflicts with an existing Connector identity',
        'mainMessage.connectorNameAliasConflict'
      ],
      [
        'Connector ID "arxiv" is reserved by a built-in connector',
        'mainMessage.connectorIdReserved'
      ],
      ['A custom connector with ID "my-tools" already exists', 'mainMessage.connectorIdExists'],
      [
        'Connector ID "web" conflicts with an existing Connector alias',
        'mainMessage.connectorIdAliasConflict'
      ]
    ]
    for (const [message, key] of cases) {
      const quoted = /"([^"]+)"/.exec(message)?.[1] ?? ''
      // The rendered sentence carries the dictionary text with the captured value in its slot.
      expect(localizeMainMessage(translator, message), message).toBe(
        translator(key).replace('{name}', quoted).replace('{id}', quoted)
      )
      expect(localizeMainMessage(translator, message), message).toContain(quoted)
    }
  })

  it('does not rewrite a near-miss of a connector conflict sentence', () => {
    // The patterns are anchored and capture one quoted value; a sentence that only starts the same way
    // must reach the reader untouched rather than be half-translated.
    for (const nearMiss of [
      'Connector name "arxiv" is reserved by a built-in connector (retry later)',
      'connector name "arxiv" is reserved by a built-in connector',
      'Connector name arxiv is reserved by a built-in connector'
    ]) {
      expect(localizeMainMessage(translator, nearMiss), nearMiss).toBe(nearMiss)
    }
  })

  it('fills a composed sentence from what main sends', () => {
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

  it('unwraps the transport envelope so a sink can match what main composed', () => {
    // Electron shape: repo-observed form of a rejected invoke (the error class name rides along).
    expect(
      unwrapIpcEnvelope(
        "Error invoking remote method 'notebook:run-cell': NotebookRunDeclinedError: Notebook run declined: fs-delete"
      )
    ).toBe('Notebook run declined: fs-delete')
    // Web RPC shape: http-server.ts sends `error.message` verbatim, so there is no envelope at all.
    expect(unwrapIpcEnvelope('Notebook run declined: fs-delete')).toBe(
      'Notebook run declined: fs-delete'
    )
    expect(unwrapIpcEnvelope("Error invoking remote method 'x:y': Error: ENOENT")).toBe('ENOENT')
  })

  it('does not mistake an ordinary message for an envelope', () => {
    expect(unwrapIpcEnvelope('EACCES: permission denied')).toBe('EACCES: permission denied')
  })

  it('strips a specific error-name label but leaves a bare label alone', () => {
    // A label WITH a colon is the shape a JS error carries, so it goes; a message that is only the
    // word `Error` is not something this helper invented, and it is returned as it came.
    expect(unwrapIpcEnvelope("Error invoking remote method 'x:y': TypeError: bad shape")).toBe(
      'bad shape'
    )
    expect(unwrapIpcEnvelope('Error')).toBe('Error')
    expect(unwrapIpcEnvelope('EACCES: permission denied')).toBe('EACCES: permission denied')
  })
})
