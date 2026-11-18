import { describe, expect, it } from 'vitest'

import { postInstallView } from './specialist-marketplace-install-outcome'

describe('postInstallView', () => {
  it('sends a package that still needs setup to its editor, not back to the list', () => {
    expect(postInstallView({ setupPending: true, specialistId: 'tcm-evidence-expert' })).toEqual({
      kind: 'edit',
      id: 'tcm-evidence-expert'
    })
  })

  it('returns to the list when the install is already usable', () => {
    expect(postInstallView({ setupPending: false, specialistId: 'tcm-evidence-expert' })).toEqual({
      kind: 'list'
    })
    expect(postInstallView({ specialistId: 'tcm-evidence-expert' })).toEqual({ kind: 'list' })
  })
})
