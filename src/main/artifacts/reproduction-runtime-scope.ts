import { join } from 'node:path'

import { envPrefix, pythonBin, rBin, resolveEnvName, runtimeRoot } from '../notebook/runtime-paths'

// Runtime scope for an isolated replay: which interpreter runs the recipe, and which bytes the recorded
// inputs point at. Kept separate from the ipc wiring so both rules are unit-testable — they are the two
// places where a mistake would quietly run the wrong thing (another environment, or a file outside the
// data root).

// The interpreter of the environment the recipe was captured in. A missing environment is the caller's
// problem to report (the runner refuses with `interpreter-missing`), never something to work around by
// substituting a different runtime.
export const resolveReplayInterpreter = ({
  dataRoot,
  kernelKind,
  environmentName
}: {
  dataRoot: string
  kernelKind: 'python' | 'r'
  environmentName?: string
}): string => {
  const envName = resolveEnvName(kernelKind, environmentName)
  const prefix = envPrefix(runtimeRoot(dataRoot), envName)

  return kernelKind === 'r' ? rBin(prefix) : pythonBin(prefix)
}

// Recorded inputs are addressed by storage key relative to the data root. A key that contains `..` is
// returned unchanged on purpose: `join` would happily normalise it out of the data root, and the runner
// already refuses to stage a path it cannot resolve, so the escape attempt surfaces as a refusal
// instead of a read somewhere else on disk.
export const resolveStoredInputPath = ({
  dataRoot,
  storageKey
}: {
  dataRoot: string
  storageKey: string
}): string => {
  const segments = storageKey.split('/').filter((segment) => segment.length > 0)
  if (segments.includes('..')) return storageKey

  return join(dataRoot, ...segments)
}

export const replayEnvironmentName = ({
  kernelKind,
  environmentName
}: {
  kernelKind: 'python' | 'r'
  environmentName?: string
}): string => resolveEnvName(kernelKind, environmentName)
