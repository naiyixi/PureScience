import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  describeInstalledRuntime,
  describeWindowsExitStatus,
  diagnoseRuntimeFailure,
  formatRuntimeFailure,
  peMachineForArch,
  readBinaryIdentity
} from './runtime-failure-diagnosis'

// A minimal-but-real PE header: 'MZ', the PE header offset at 0x3C, then 'PE\0\0' + the machine word.
// The classifier reads nothing else, so these fixtures exercise the real parser rather than a stub.
const peHeader = (machine: number, size = 1024): Buffer => {
  const buffer = Buffer.alloc(size)
  buffer.write('MZ', 0, 'latin1')
  buffer.writeUInt32LE(0x80, 0x3c)
  buffer.write('PE\0\0', 0x80, 'latin1')
  buffer.writeUInt16LE(machine, 0x84)
  return buffer
}

const STATUS_ENTRYPOINT_NOT_FOUND = 3221225785
const STATUS_DLL_NOT_FOUND = 3221225781
const STATUS_ILLEGAL_INSTRUCTION = 3221225501

describe('runtime failure diagnosis', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-diagnosis-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('names the NTSTATUS behind a Windows exit status, signed or unsigned', () => {
    expect(describeWindowsExitStatus(STATUS_ENTRYPOINT_NOT_FOUND)?.name).toBe(
      'STATUS_ENTRYPOINT_NOT_FOUND'
    )
    // Node surfaces the same status as a negative 32-bit number when the spawn reports a signal-shaped
    // exit; both spellings must resolve to the same name or the message silently degrades to a number.
    expect(describeWindowsExitStatus(STATUS_ENTRYPOINT_NOT_FOUND | 0)?.name).toBe(
      'STATUS_ENTRYPOINT_NOT_FOUND'
    )
    expect(describeWindowsExitStatus(STATUS_ILLEGAL_INSTRUCTION)?.name).toBe(
      'STATUS_ILLEGAL_INSTRUCTION'
    )
    expect(describeWindowsExitStatus(1)).toBeUndefined()
    expect(describeWindowsExitStatus(null)).toBeUndefined()
  })

  it('reads a PE file as the machine it was built for', async () => {
    const x64 = join(dir, 'x64.exe')
    const arm64 = join(dir, 'arm64.exe')
    await writeFile(x64, peHeader(0x8664))
    await writeFile(arm64, peHeader(0xaa64))

    expect(await readBinaryIdentity(x64)).toEqual({ kind: 'pe', machine: 'x64', size: 1024 })
    expect(await readBinaryIdentity(arm64)).toEqual({ kind: 'pe', machine: 'arm64', size: 1024 })
    expect(peMachineForArch('x64')).toBe('x64')
    expect(peMachineForArch('ia32')).toBe('x86')
  })

  it('separates a missing file, an empty file and a wrong-CPU build', async () => {
    const empty = join(dir, 'empty.exe')
    const arm64 = join(dir, 'wrong-arch.exe')
    await writeFile(empty, '')
    await writeFile(arm64, peHeader(0xaa64))

    expect((await readBinaryIdentity(join(dir, 'nothing-here.exe'))).kind).toBe('missing')
    expect(
      diagnoseRuntimeFailure({ identity: await readBinaryIdentity(empty), platform: 'win32' }).cause
    ).toBe('empty-file')
    // The architecture is checked before the exit status: an arm64 build on an x64 machine explains the
    // loader failure, and "install again" is the fix rather than a redistributable.
    expect(
      diagnoseRuntimeFailure({
        identity: await readBinaryIdentity(arm64),
        status: STATUS_ENTRYPOINT_NOT_FOUND,
        platform: 'win32',
        hostArch: 'x64'
      }).cause
    ).toBe('wrong-architecture')
  })

  it('reads a loader status as a missing native library when the file matches this CPU', async () => {
    const x64 = join(dir, 'matching.exe')
    await writeFile(x64, peHeader(0x8664))

    const diagnosis = diagnoseRuntimeFailure({
      identity: await readBinaryIdentity(x64),
      status: STATUS_DLL_NOT_FOUND,
      platform: 'win32',
      hostArch: 'x64'
    })

    expect(diagnosis.cause).toBe('missing-native-library')
    expect(diagnosis.summary).toContain('STATUS_DLL_NOT_FOUND')
    expect(diagnosis.nextStep).toContain('Visual C++')
    expect(formatRuntimeFailure(diagnosis)).toMatch(/\(evidence: PE x64, 1024 bytes\)\.$/)
  })

  it('treats a script as broken only where it cannot be launched, and never for a .js entry point', async () => {
    const shim = join(dir, 'opencode')
    const adapter = join(dir, 'index.js')
    await writeFile(shim, '#!/bin/sh\nopencode "$@"\n')
    await writeFile(adapter, '#!/usr/bin/env node\nconsole.log(1)\n')

    expect(
      diagnoseRuntimeFailure({
        identity: await readBinaryIdentity(shim),
        platform: 'win32'
      }).cause
    ).toBe('script-without-interpreter')

    // The adapter is launched through node on every platform, so "a script" is its normal shape.
    await expect(describeInstalledRuntime(adapter, { platform: 'win32' })).resolves.toBeNull()
  })

  it('reports nothing when the file looks runnable and only the runtime knows why it failed', async () => {
    const x64 = join(dir, 'plausible.exe')
    await writeFile(x64, peHeader(0x8664))

    // Unknown non-zero status: the file is fine, so the caller keeps its own message rather than
    // blaming an install that is not broken.
    await expect(
      describeInstalledRuntime(x64, { platform: 'win32', hostArch: 'x64' })
    ).resolves.toBeNull()
  })
})
