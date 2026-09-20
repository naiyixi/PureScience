import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { formatDoctor, formatInit, runDoctor, runInit } from './doctor.mjs'

// What these tests hold the commands to: every line is something that was measured here (a path, a pid, a
// permission, a version), the readiness verdict is explicitly not this command's, and a secret never reaches
// the output. The token check is the one that would be easiest to get wrong, so it is asserted directly.

const roots = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'purescience-doctor-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  // Nothing is removed here: the roots are under the scratch tmpdir and the assertions need them intact
  // until the test ends. Pruning is the OS's job.
})

describe('purescience doctor', () => {
  it('reports a missing config root as a warning, with the path it looked at', async () => {
    const root = join(await makeRoot(), 'not-created-yet')
    const report = await runDoctor({ configRoot: root, appPath: '/nonexistent/purescience', env: {} })

    const rootCheck = report.checks.find((entry) => entry.check === 'config_root')
    expect(rootCheck?.status).toBe('warn')
    expect(rootCheck?.evidence.path).toBe(root)
    expect(report.configRoot).toBe(root)
  })

  it('measures the root it is given: directory, mode, and that it can actually be written', async () => {
    const root = await makeRoot()
    const report = await runDoctor({ configRoot: root, appPath: '/nonexistent/purescience', env: {} })
    const rootCheck = report.checks.find((entry) => entry.check === 'config_root')

    expect(rootCheck?.status).toBe('ok')
    expect(rootCheck?.evidence.writable).toBe(true)
    expect(rootCheck?.evidence.isDirectory).toBe(true)
  })

  // A recorded pid whose process is gone must be reported as such, not smoothed into "running".
  it('distinguishes a recorded service from a live one', async () => {
    const root = await makeRoot()
    // A pid that cannot exist: the kernel's highest pid is far below this on macOS and Linux.
    await writeFile(
      join(root, 'web-service.json'),
      JSON.stringify({ pid: 2_147_483_647, port: 44100, startedAt: new Date().toISOString() }),
      'utf8'
    )
    const report = await runDoctor({ configRoot: root, appPath: '/nonexistent/purescience', env: {} })
    const stateCheck = report.checks.find((entry) => entry.check === 'service_state')

    expect(stateCheck?.status).toBe('warn')
    expect(stateCheck?.evidence.pidAlive).toBe(false)
    expect(stateCheck?.evidence.pid).toBe(2_147_483_647)
    expect(String(stateCheck?.evidence.detail)).toContain('已不在')
  })

  it('fails a state file that cannot be parsed rather than calling it absent', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'web-service.json'), '{"pid":"not-a-number"}', 'utf8')
    const report = await runDoctor({ configRoot: root, appPath: '/nonexistent/purescience', env: {} })
    const stateCheck = report.checks.find((entry) => entry.check === 'service_state')

    expect(stateCheck?.status).toBe('fail')
    expect(String(stateCheck?.evidence.detail)).toContain('解析不出')
  })

  // The token is reported by presence and length; its value must not appear anywhere in the output.
  it('never prints the web token, only that it is there and how long it is', async () => {
    const root = await makeRoot()
    const token = 'sup3r-s3cret-token-value'
    await writeFile(join(root, 'web-token'), `${token}\n`, 'utf8')

    const report = await runDoctor({ configRoot: root, appPath: '/nonexistent/purescience', env: {} })
    const tokenCheck = report.checks.find((entry) => entry.check === 'web_token')

    expect(tokenCheck?.status).toBe('ok')
    expect(tokenCheck?.evidence.length).toBe(token.length)
    expect(tokenCheck?.evidence.value).toBeUndefined()
    expect(JSON.stringify(report)).not.toContain(token)
    expect(formatDoctor(report)).not.toContain(token)
  })

  // The point of the command: it counts what it measured and says where the verdict comes from.
  it('summarizes measured checks and points the readiness verdict at the ready command', async () => {
    const root = await makeRoot()
    const report = await runDoctor({ configRoot: root, appPath: '/nonexistent/purescience', env: {} })

    expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(report.checks.length)
    expect(report.readiness.decidedBy).toBe('purescience ready')
    expect(report.readiness.note).toContain('本命令只报告在本机测得的事实')
    const formatted = formatDoctor(report)
    expect(formatted).toContain('measured:')
    expect(formatted).toContain('就绪判定不在这里')
    // No line may claim the machine is ready — that verdict belongs to the application.
    expect(formatted.toLowerCase()).not.toContain('is ready')
  })

  it('checks the runtime against the requirement the package itself declares', async () => {
    const root = await makeRoot()
    const report = await runDoctor({ configRoot: root, appPath: '/nonexistent/purescience', env: {} })
    const nodeCheck = report.checks.find((entry) => entry.check === 'node')
    expect(nodeCheck?.evidence.version).toBe(process.versions.node)
    // The requirement comes from the package's own engines field, so the check cannot drift from it.
    expect(nodeCheck?.evidence.required).toBe('>=22.5.0')
    expect(nodeCheck?.evidence.meetsRequirement).toBe(true)
  })
})

describe('purescience init', () => {
  it('creates the config root and writes no settings', async () => {
    const base = await makeRoot()
    const root = join(base, 'fresh-root')
    const result = await runInit({ configRoot: root, appPath: '/nonexistent/purescience', env: {} })

    expect(result.created).toBe(true)
    expect(result.wroteSettings).toBe(false)
    const info = await stat(root)
    expect(info.isDirectory()).toBe(true)
    expect(info.mode & 0o777).toBe(0o700)
    expect(result.contents).toEqual({ stateFile: false, tokenFile: false })
    expect(formatInit(result)).toContain('created (mode 0700)')
  })

  // An existing root is confirmed, not rebuilt: overwriting a state file could break a running service.
  it('leaves an existing root and its files alone', async () => {
    const root = await makeRoot()
    const statePath = join(root, 'web-service.json')
    const original = JSON.stringify({ pid: 4242, port: 44100, startedAt: '2026-09-20T00:00:00.000Z' })
    await writeFile(statePath, original, 'utf8')

    const result = await runInit({ configRoot: root, appPath: '/nonexistent/purescience', env: {} })

    expect(result.created).toBe(false)
    expect(result.contentsUntouched).toBe(true)
    expect(result.contents.stateFile).toBe(true)
    expect(await readFile(statePath, 'utf8')).toBe(original)
  })
})
