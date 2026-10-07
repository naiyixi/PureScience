import { describe, expect, it } from 'vitest'

import {
  REMOTE_UNPROTECTED_POLICY_LABELS,
  REMOTE_UNPROTECTED_SETTING_PATH,
  remoteUnprotectedRefusalMessage
} from '../../../shared/execution-protection'
import { en } from './en'

// A refusal that tells the reader to open "Settings → Execution protection → …" is only useful while
// the words it quotes are the ones the panel actually shows there. That text lives in `shared` (it
// travels to the agent as instructions, so it is deliberately not localized) while the labels live in
// the dictionary — nothing else ties the two together, so an option renamed in `en.ts` would silently
// leave a refusal pointing at a setting by a name that no longer exists. This is that tie.
describe('execution-protection policy labels quoted by the remote refusal', () => {
  it('are the very labels the panel renders in English', () => {
    expect(en['protection.policyConfirm']).toBe(REMOTE_UNPROTECTED_POLICY_LABELS.confirm)
    expect(en['protection.policyRemembered']).toBe(REMOTE_UNPROTECTED_POLICY_LABELS.remembered)
    expect(en['protection.policyDeny']).toBe(REMOTE_UNPROTECTED_POLICY_LABELS.deny)
  })

  it('names the setting as the reader finds it, by its own section titles', () => {
    expect(REMOTE_UNPROTECTED_SETTING_PATH).toContain(en['settings.executionProtection'])
    expect(REMOTE_UNPROTECTED_SETTING_PATH).toContain(en['protection.policyTitle'])
  })

  it('says what happened, quotes the two options that change it, and names the host', () => {
    const message = remoteUnprotectedRefusalMessage('viper')

    expect(message).toContain('viper')
    // The fact that used to be reported wrongly: nothing was submitted and nobody was asked.
    expect(message).toContain('no approval was requested')
    expect(message).toContain(REMOTE_UNPROTECTED_SETTING_PATH)
    expect(message).toContain(REMOTE_UNPROTECTED_POLICY_LABELS.confirm)
    expect(message).toContain(REMOTE_UNPROTECTED_POLICY_LABELS.remembered)
  })
})
