import { useEffect, useState } from 'react'

import type { AcpStateSnapshot } from '../../../../shared/acp'

// Whether the runtime is currently taking a provider change through.
//
// Main has tracked this all along — it is what model changes and prompt turns consult — but the flag only
// reached the renderer with the snapshot field. The settings panel is where the change is made, so it is
// where the user should see that it is being applied, instead of wondering whether the click worked.

const useProviderReconnectStatus = (): boolean => {
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let live = true
    const apply = (state: AcpStateSnapshot): void => {
      if (live) setPending(state?.providerReconnectPending === true)
    }

    // The settings panel can be rendered where the ACP surface is not present (web mode, tests); a
    // missing surface means "nothing to report", never a crash.
    const acp = window.api?.acp
    if (typeof acp?.getState !== 'function' || typeof acp?.onState !== 'function') return

    void acp
      .getState()
      .then(apply)
      .catch(() => undefined)
    const remove = acp.onState(apply)

    return () => {
      live = false
      remove()
    }
  }, [])

  return pending
}

export { useProviderReconnectStatus }
