import { open, stat } from 'node:fs/promises'

// Why this module exists: on Windows a managed runtime install can report "extracted" and then die at
// the very first `--version` spawn with nothing but an NTSTATUS number in the exit code. Four different
// runtimes failed that way on one real machine and every card said the same unhelpful sentence
// ("could not report its version … reinstall"), so the user could only retry blindly. The three
// mechanisms that actually produce it are distinguishable from the OUTSIDE — a 0-byte download, a
// binary for the wrong CPU, or a native executable whose loader can't resolve an import — so the app
// should say which one it is instead of asking for a reinstall and hoping.
//
// Everything here is read-only and cheap (one stat + at most 4 KiB), and the classification is a pure
// function of what was read, so the whole thing is testable off-Windows.

export type PeMachine = 'x64' | 'arm64' | 'x86' | 'arm' | 'unknown-machine'

export type BinaryIdentity =
  | { kind: 'missing' }
  | { kind: 'empty'; size: number }
  | { kind: 'pe'; machine: PeMachine; size: number }
  | { kind: 'script'; shebang: string; size: number }
  | { kind: 'unknown'; size: number }

const PE_MACHINES: Record<number, 'x64' | 'arm64' | 'x86' | 'arm'> = {
  0x8664: 'x64',
  0xaa64: 'arm64',
  0x014c: 'x86',
  0x01c0: 'arm',
  0x01c4: 'arm'
}

// Host arch → the PE machine a native binary must carry to run without emulation.
export const peMachineForArch = (arch: string): PeMachine =>
  arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'x86' : 'unknown-machine'

const readPeMachine = (header: Buffer): PeMachine => {
  // MZ magic, then the little-endian offset of the PE header at 0x3C.
  if (header.length < 0x40 || header.toString('latin1', 0, 2) !== 'MZ') return 'unknown-machine'
  const peOffset = header.readUInt32LE(0x3c)
  if (peOffset + 6 > header.length) return 'unknown-machine'
  if (header.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return 'unknown-machine'

  return PE_MACHINES[header.readUInt16LE(peOffset + 4)] ?? 'unknown-machine'
}

/**
 * What is actually on disk at `filePath`, in the terms the failure modes are made of.
 *
 * A missing path answers `missing` rather than throwing: "the installer said it wrote a file and there
 * is no file" is itself one of the diagnoses (Defender quarantine, a rollback, a wrong prefix).
 */
export const readBinaryIdentity = async (filePath: string): Promise<BinaryIdentity> => {
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch {
    return { kind: 'missing' }
  }
  if (size === 0) return { kind: 'empty', size }

  const handle = await open(filePath, 'r')
  try {
    const header = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const head = header.subarray(0, bytesRead)
    if (head.length >= 2 && head.toString('latin1', 0, 2) === 'MZ') {
      return { kind: 'pe', machine: readPeMachine(head), size }
    }
    if (head.length >= 2 && head.toString('latin1', 0, 2) === '#!') {
      const firstLine = head.toString('utf8', 0, Math.max(0, head.indexOf(0x0a) + 1 || 80))
      return { kind: 'script', shebang: firstLine.trim(), size }
    }
    return { kind: 'unknown', size }
  } finally {
    await handle.close()
  }
}

export type WindowsStatus = Readonly<{ code: number; hex: string; name: string; meaning: string }>

// Windows reports a loader failure as an NTSTATUS value in the exit status. Node surfaces it either
// unsigned (3221225785) or as signed 32-bit (-1073741511), so both spellings are accepted.
const WINDOWS_STATUSES: readonly WindowsStatus[] = [
  {
    code: 0xc0000135,
    hex: '0xC0000135',
    name: 'STATUS_DLL_NOT_FOUND',
    meaning: 'a library the executable imports is not installed on this machine'
  },
  {
    code: 0xc0000139,
    hex: '0xC0000139',
    name: 'STATUS_ENTRYPOINT_NOT_FOUND',
    meaning:
      'the executable loaded but a library it links against is a different build than it expects (incomplete install, or a missing Visual C++ runtime)'
  },
  {
    code: 0xc0000142,
    hex: '0xC0000142',
    name: 'STATUS_DLL_INIT_FAILED',
    meaning: 'the executable could not initialise its runtime'
  },
  {
    code: 0xc000001d,
    hex: '0xC000001D',
    name: 'STATUS_ILLEGAL_INSTRUCTION',
    meaning: 'the binary was built for newer CPU instructions than this machine provides'
  },
  {
    code: 0xc0000005,
    hex: '0xC0000005',
    name: 'STATUS_ACCESS_VIOLATION',
    meaning: 'the executable crashed while starting'
  }
]

/** Names the NTSTATUS behind a Windows exit status; undefined for ordinary exit codes. */
export const describeWindowsExitStatus = (
  status: number | null | undefined
): WindowsStatus | undefined => {
  if (typeof status !== 'number' || status === 0) return undefined
  const unsigned = status < 0 ? status >>> 0 : status
  return WINDOWS_STATUSES.find((entry) => entry.code === unsigned)
}

export type RuntimeFailureCause =
  | 'missing-file'
  | 'empty-file'
  | 'wrong-architecture'
  | 'script-without-interpreter'
  | 'missing-native-library'
  | 'illegal-instruction'
  | 'not-a-windows-binary'
  | 'unknown'

export type RuntimeFailureDiagnosis = Readonly<{
  cause: RuntimeFailureCause
  summary: string
  nextStep: string
  evidence: string
}>

const describeIdentity = (identity: BinaryIdentity): string =>
  identity.kind === 'missing'
    ? 'file missing'
    : identity.kind === 'empty'
      ? 'file is 0 bytes'
      : identity.kind === 'pe'
        ? `PE ${identity.machine}, ${identity.size} bytes`
        : identity.kind === 'script'
          ? `script (${identity.shebang}), ${identity.size} bytes`
          : `unrecognised content, ${identity.size} bytes`

/**
 * Classify one failed start of an installed runtime.
 *
 * Order matters: what is on disk explains more than the exit code does, so an empty or wrong-CPU file
 * is named before the loader status it happens to produce.
 */
export const diagnoseRuntimeFailure = (
  input: Readonly<{
    identity: BinaryIdentity
    status?: number | null
    platform?: NodeJS.Platform
    hostArch?: string
    // A `.js` entry point on Windows IS launched through node, so "a script, not an executable" is not a
    // defect there — without this the adapter check would report every healthy adapter as broken.
    jsEntryPoint?: boolean
  }>
): RuntimeFailureDiagnosis => {
  const platform = input.platform ?? process.platform
  const hostArch = input.hostArch ?? process.arch
  const identity = input.identity
  const evidence = describeIdentity(identity)
  const wanted = peMachineForArch(hostArch)

  if (identity.kind === 'missing') {
    return {
      cause: 'missing-file',
      summary: 'the installer reported success but there is no file at the installed path',
      nextStep:
        'this is usually the operating system or a security product removing the file it just downloaded — allow the app folder in the antivirus exclusion list, then install again',
      evidence
    }
  }
  if (identity.kind === 'empty') {
    return {
      cause: 'empty-file',
      summary: 'the installed file is empty',
      nextStep:
        'the download was cut off or blocked, so install again; if it repeats, switch the download mirror',
      evidence
    }
  }
  if (
    identity.kind === 'pe' &&
    identity.machine !== 'unknown-machine' &&
    identity.machine !== wanted
  ) {
    return {
      cause: 'wrong-architecture',
      summary: `the installed binary is built for ${identity.machine} but this machine is ${hostArch}`,
      nextStep: 'install again so the download picks this machine’s architecture',
      evidence
    }
  }
  if (identity.kind === 'script' && platform === 'win32' && input.jsEntryPoint !== true) {
    return {
      cause: 'script-without-interpreter',
      summary: 'the installed entry point is a script rather than an executable',
      nextStep:
        'the interpreter it names is not available to the app on Windows — install the runtime from the app’s own managed download instead of a global package',
      evidence
    }
  }

  const status = describeWindowsExitStatus(input.status)
  if (status?.name === 'STATUS_ILLEGAL_INSTRUCTION') {
    return {
      cause: 'illegal-instruction',
      summary: `the binary needs CPU instructions this machine does not provide (${status.hex} ${status.name})`,
      nextStep: 'install the baseline build of this runtime',
      evidence
    }
  }
  if (
    status &&
    (status.name === 'STATUS_DLL_NOT_FOUND' || status.name === 'STATUS_ENTRYPOINT_NOT_FOUND')
  ) {
    return {
      cause: 'missing-native-library',
      summary: `${status.hex} ${status.name}: ${status.meaning}`,
      nextStep:
        'install the Microsoft Visual C++ 2015–2022 Redistributable (same architecture as the app), then install the runtime again',
      evidence
    }
  }
  if (platform === 'win32' && identity.kind === 'unknown') {
    return {
      cause: 'not-a-windows-binary',
      summary: 'the installed file is not a Windows executable',
      nextStep: 'install again so the download picks the Windows package for this machine',
      evidence
    }
  }

  return {
    cause: 'unknown',
    summary: status
      ? `${status.hex} ${status.name}: ${status.meaning}`
      : 'the file is there and looks runnable on this machine, yet it exits before printing a version',
    nextStep:
      'the runtime’s own log (or running it once from a terminal) will name the reason; the evidence line below is what to send with a bug report',
    evidence: status ? `${evidence}; exit ${input.status}` : evidence
  }
}

/** One sentence a status card can show without a second lookup. */
export const formatRuntimeFailure = (diagnosis: RuntimeFailureDiagnosis): string =>
  `${diagnosis.summary}. ${diagnosis.nextStep[0]?.toUpperCase() ?? ''}${diagnosis.nextStep.slice(1)} (evidence: ${diagnosis.evidence}).`

/**
 * Read the installed file and report ONLY when something is visibly wrong with it.
 *
 * `null` means "this file is a plausible executable for this machine": the caller then keeps its own
 * message (typically the runtime refused to print a version for a reason that lives inside the
 * runtime), instead of blaming an install that is actually fine.
 */
export const describeInstalledRuntime = async (
  filePath: string,
  options?: Readonly<{ status?: number | null; platform?: NodeJS.Platform; hostArch?: string }>
): Promise<RuntimeFailureDiagnosis | null> => {
  const diagnosis = diagnoseRuntimeFailure({
    identity: await readBinaryIdentity(filePath),
    ...(options?.status === undefined ? {} : { status: options.status }),
    ...(options?.platform === undefined ? {} : { platform: options.platform }),
    ...(options?.hostArch === undefined ? {} : { hostArch: options.hostArch }),
    ...(/\.[cm]?js$/i.test(filePath) ? { jsEntryPoint: true } : {})
  })

  return diagnosis.cause === 'unknown' ? null : diagnosis
}
