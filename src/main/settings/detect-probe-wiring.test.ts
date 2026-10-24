// Wiring proof for the identity-keyed version probes.
//
// The cache itself is covered by version-probe-cache.test.ts, but that only proves the helper works —
// it cannot see whether the production dependency bundles actually use it. An unwrapped `getVersion`
// would behave exactly like a wrapped one in every other test (same answer, just paid for again), so
// each factory is exercised here against a real executable that reports a DIFFERENT version on every
// spawn: the second call answering the first call's version is what proves no second spawn happened.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDefaultDetectDeps as createClaudeDetectDeps } from './claude-detect'
import { createDefaultDetectDeps as createOpencodeDetectDeps } from './opencode-detect'
import { createDefaultDetectDeps as createCodeBuddyDetectDeps } from './codebuddy-detect'
import { createDefaultDetectDeps as createCodexDetectDeps } from './codex-detect'

// A POSIX shell script is the only portable "real executable" here; Windows probes go through a shell
// and are covered by the unit-level cache tests instead.
const describePosix = process.platform === 'win32' ? describe.skip : describe

// `spawnCount` lives in a sidecar file, not in the script: rewriting the script itself would change the
// file identity and defeat what is being measured.
const writeCountingBinary = async (binary: string, counter: string): Promise<void> => {
  await writeFile(
    binary,
    [
      '#!/bin/sh',
      `count=$(cat '${counter}' 2>/dev/null || echo 0)`,
      'count=$((count + 1))',
      `echo "$count" > '${counter}'`,
      'echo "1.2.$count"',
      ''
    ].join('\n')
  )
  await chmod(binary, 0o755)
}

const spawnCount = async (counter: string): Promise<number> => {
  try {
    return Number((await readFile(counter, 'utf8')).trim())
  } catch {
    return 0
  }
}

describePosix('default detect bundles memoise version probes by file identity', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'detect-probe-wiring-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('probes the selected CLAUDE binary once while its bytes are unchanged', async () => {
    const binary = join(root, 'claude')
    const counter = join(root, 'claude.count')
    await writeCountingBinary(binary, counter)
    const { getVersion } = createClaudeDetectDeps()

    await expect(getVersion(binary)).resolves.toBe('1.2.1')
    await expect(getVersion(binary)).resolves.toBe('1.2.1')
    expect(await spawnCount(counter)).toBe(1)

    // A binary replaced in place is a different file, so the answer must be re-read rather than reused.
    await writeCountingBinary(binary, counter)
    await expect(getVersion(binary)).resolves.toBe('1.2.2')
    expect(await spawnCount(counter)).toBe(2)
  })

  it('probes the selected opencode binary once while its bytes are unchanged', async () => {
    const binary = join(root, 'opencode')
    const counter = join(root, 'opencode.count')
    await writeCountingBinary(binary, counter)
    const { getVersion } = createOpencodeDetectDeps()

    await expect(getVersion(binary)).resolves.toBe('1.2.1')
    await expect(getVersion(binary)).resolves.toBe('1.2.1')
    expect(await spawnCount(counter)).toBe(1)
  })

  it('probes the selected codebuddy binary once while its bytes are unchanged', async () => {
    const binary = join(root, 'codebuddy')
    const counter = join(root, 'codebuddy.count')
    await writeCountingBinary(binary, counter)
    const { getVersion } = createCodeBuddyDetectDeps()

    await expect(getVersion(binary)).resolves.toBe('1.2.1')
    await expect(getVersion(binary)).resolves.toBe('1.2.1')
    expect(await spawnCount(counter)).toBe(1)
  })

  it('probes the codex adapter and the native codex binary once each', async () => {
    const adapter = join(root, 'codex-acp')
    const native = join(root, 'codex')
    const adapterCounter = join(root, 'adapter.count')
    const nativeCounter = join(root, 'native.count')
    await writeCountingBinary(adapter, adapterCounter)
    await writeCountingBinary(native, nativeCounter)
    const { getAdapterVersion, getCodexVersion } = createCodexDetectDeps()

    await expect(getAdapterVersion(adapter)).resolves.toBe('1.2.1')
    await expect(getAdapterVersion(adapter)).resolves.toBe('1.2.1')
    await expect(getCodexVersion(native)).resolves.toBe('1.2.1')
    await expect(getCodexVersion(native)).resolves.toBe('1.2.1')

    expect(await spawnCount(adapterCounter)).toBe(1)
    expect(await spawnCount(nativeCounter)).toBe(1)
  })

  it('does not spawn at all for a path that holds no file', async () => {
    const { getVersion } = createClaudeDetectDeps()

    await expect(getVersion(join(root, 'not-installed', 'claude'))).resolves.toBeUndefined()
  })
})
