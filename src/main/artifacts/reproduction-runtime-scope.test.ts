import { basename, isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_PY_ENV, DEFAULT_R_ENV, envPrefix, runtimeRoot } from '../notebook/runtime-paths'
import {
  replayEnvironmentName,
  resolveReplayInterpreter,
  resolveStoredInputPath
} from './reproduction-runtime-scope'

const dataRoot = join('/tmp', 'purescience-data')

describe('resolveReplayInterpreter', () => {
  it('resolves the interpreter of the recorded python environment', () => {
    const interpreter = resolveReplayInterpreter({
      dataRoot,
      kernelKind: 'python',
      environmentName: 'my-analysis'
    })

    expect(isAbsolute(interpreter)).toBe(true)
    expect(interpreter.startsWith(envPrefix(runtimeRoot(dataRoot), 'my-analysis'))).toBe(true)
    // Platform-neutral: Windows puts python.exe at the prefix root instead of ./bin.
    expect(['python', 'python.exe']).toContain(basename(interpreter))
  })

  it('resolves the interpreter of the recorded R environment', () => {
    const interpreter = resolveReplayInterpreter({
      dataRoot,
      kernelKind: 'r',
      environmentName: 'r-analysis'
    })

    expect(interpreter.startsWith(envPrefix(runtimeRoot(dataRoot), 'r-analysis'))).toBe(true)
    expect(['R', 'R.exe']).toContain(basename(interpreter))
  })

  it('falls back to the app-managed default when the recipe names no environment', () => {
    expect(replayEnvironmentName({ kernelKind: 'python' })).toBe(DEFAULT_PY_ENV)
    expect(replayEnvironmentName({ kernelKind: 'r' })).toBe(DEFAULT_R_ENV)
    expect(
      resolveReplayInterpreter({ dataRoot, kernelKind: 'python' }).startsWith(
        envPrefix(runtimeRoot(dataRoot), DEFAULT_PY_ENV)
      )
    ).toBe(true)
  })
})

describe('resolveStoredInputPath', () => {
  it('resolves a storage key inside the data root', () => {
    expect(resolveStoredInputPath({ dataRoot, storageKey: 'uploads/project-1/groups.csv' })).toBe(
      join(dataRoot, 'uploads', 'project-1', 'groups.csv')
    )
  })

  it('never resolves a key out of the data root', () => {
    expect(resolveStoredInputPath({ dataRoot, storageKey: '../../etc/passwd' })).toBe(
      '../../etc/passwd'
    )
    expect(resolveStoredInputPath({ dataRoot, storageKey: 'uploads/../../secret' })).toBe(
      'uploads/../../secret'
    )
  })

  it('keeps an absolute key under the data root rather than reading the absolute path', () => {
    expect(resolveStoredInputPath({ dataRoot, storageKey: '/etc/passwd' })).toBe(
      join(dataRoot, 'etc', 'passwd')
    )
  })

  it('tolerates redundant separators', () => {
    expect(resolveStoredInputPath({ dataRoot, storageKey: 'uploads//a//b.csv' })).toBe(
      join(dataRoot, 'uploads', 'a', 'b.csv')
    )
  })
})
