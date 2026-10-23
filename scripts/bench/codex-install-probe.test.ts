// Real install check for the app-managed Codex runtime.
//
// Gated by an env var because it downloads pinned tarballs over the network — CI must never depend on a
// registry being reachable. Run it when you need to know whether "Codex is already installed" actually
// means "this app can use it":
//
//   CODEX_INSTALL_PROBE=<dataRoot> npx vitest run scripts/bench/codex-install-probe.test.ts
//
// The point is the gap this file exists to close: a global `codex-acp` on PATH is not the same thing as
// the app-managed adapter, and the app refuses to start a Codex session without the latter.
import { describe, expect, it } from 'vitest'

import { DEFAULT_REGISTRIES } from '../../src/main/settings/managed-claude'
import {
  installManagedCodex,
  resolveManagedCodexPlatform
} from '../../src/main/settings/managed-codex'

const dataRoot = process.env.CODEX_INSTALL_PROBE?.trim()

describe.skipIf(!dataRoot)('app-managed Codex install', () => {
  it(
    'installs from the first reachable registry and reports what it placed',
    async () => {
      const platform = resolveManagedCodexPlatform()
      const logs: string[] = []
      const outcome = await installManagedCodex({
        installId: `probe-${Date.now()}`,
        onEvent: (event) => {
          if (event.kind === 'log') logs.push(event.chunk)
        },
        dataRoot: dataRoot!,
        // Mirror first: this machine's default registry is the one that made the install look impossible.
        registries: [DEFAULT_REGISTRIES[1], DEFAULT_REGISTRIES[0]],
        platform
      })

      console.log(
        `[codex-install] platform=${platform.key} ok=${outcome.result.ok} ` +
          `adapter=${outcome.adapterPath ?? '-'} codex=${outcome.codexPath ?? '-'} ` +
          `error=${outcome.result.error ?? '-'}`
      )

      expect(outcome.result.ok).toBe(true)
      expect(outcome.adapterPath).toBeTruthy()
      expect(outcome.codexPath).toBeTruthy()
    },
    15 * 60 * 1000
  )
})
