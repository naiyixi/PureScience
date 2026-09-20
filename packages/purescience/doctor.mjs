/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { constants } from 'node:fs'
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { locateApp } from './locate-app.mjs'
import { readStateFromRoot, readWebToken, resolveConfigRoot, STATE_FILE, TOKEN_FILE } from './config-root.mjs'

// `purescience doctor` and `purescience init`.
//
// The rule both commands obey is the one the `ready` command already states: there is exactly one place
// that decides whether this machine is ready, and it is the application. A doctor that re-decides would be
// a second implementation of that judgement, and the two would drift. So this reports facts it measured
// here — a path, a pid, a permission, a version — each with the evidence it was measured from, and then
// says out loud that the readiness verdict comes from `purescience ready`.
//
// No secret is ever printed: the token is reported by presence and length, which is enough to see that it
// is there and mounted, and not enough to leak it into a log.

// The requirement is read from this package's own engines field — one source of truth rather than a second
// number that can drift away from what the package actually declares.
const readEnginesRequirement = async () => {
  try {
    const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
    const engines = manifest && typeof manifest.engines === 'object' ? manifest.engines : {}
    const declared = typeof engines.node === 'string' ? engines.node : undefined
    return declared
  } catch {
    return undefined
  }
}

const meetsRequirement = (version, requirement) => {
  const wanted = /(\d+)(?:\.(\d+))?/.exec(String(requirement ?? ''))
  if (!wanted) return undefined
  const [major, minor] = version.split('.').map((part) => Number(part))
  const wantMajor = Number(wanted[1])
  const wantMinor = wanted[2] === undefined ? 0 : Number(wanted[2])
  if (major !== wantMajor) return major > wantMajor
  return minor >= wantMinor
}

const probe = async (path) => {
  try {
    await access(path, constants.F_OK)
  } catch {
    return { exists: false }
  }
  try {
    const info = await stat(path)
    return { exists: true, mode: (info.mode & 0o777).toString(8), isDirectory: info.isDirectory() }
  } catch {
    return { exists: true }
  }
}

const pidAlive = (pid) => {
  try {
    // Signal 0 asks the OS whether the process exists without touching it.
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

const writableProbe = async (root) => {
  const probePath = join(root, '.purescience-write-probe')
  try {
    await writeFile(probePath, 'probe', { mode: 0o600 })
    await rm(probePath, { force: true })
    return { writable: true }
  } catch (error) {
    return { writable: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const check = (name, status, evidence) => ({ check: name, status, evidence })

export const runDoctor = async ({ configRoot, appPath, env = process.env } = {}) => {
  const root = resolveConfigRoot({ override: configRoot, env })
  const checks = []

  const rootState = await probe(root)
  if (!rootState.exists) {
    checks.push(check('config_root', 'warn', { path: root, detail: '不存在；`purescience init` 会创建它' }))
  } else {
    const writable = rootState.isDirectory ? await writableProbe(root) : { writable: false }
    checks.push(
      check('config_root', writable.writable ? 'ok' : 'fail', {
        path: root,
        mode: rootState.mode,
        isDirectory: rootState.isDirectory === true,
        writable: writable.writable,
        ...(writable.error ? { error: writable.error } : {})
      })
    )
  }

  const statePath = join(root, STATE_FILE)
  const stateProbe = await probe(statePath)
  const state = stateProbe.exists ? await readStateFromRoot(root) : undefined
  if (!stateProbe.exists) {
    checks.push(check('service_state', 'warn', { path: statePath, detail: '没有状态文件：后台服务未运行过或被清理' }))
  } else if (!state) {
    checks.push(check('service_state', 'fail', { path: statePath, detail: '状态文件存在但解析不出 pid/port/startedAt' }))
  } else {
    const alive = pidAlive(state.pid)
    checks.push(
      check('service_state', alive ? 'ok' : 'warn', {
        path: statePath,
        pid: state.pid,
        port: state.port,
        startedAt: state.startedAt,
        pidAlive: alive,
        detail: alive ? undefined : '记录了 pid 但该进程已不在；下一次 start 会重新起'
      })
    )
  }

  const tokenPath = join(root, TOKEN_FILE)
  const tokenProbe = await probe(tokenPath)
  if (!tokenProbe.exists) {
    checks.push(check('web_token', 'warn', { path: tokenPath, detail: '还没有令牌：服务启动时才会生成' }))
  } else {
    try {
      const token = await readWebToken(root)
      // Presence and length only — the value itself never enters this output.
      checks.push(check('web_token', token.length > 0 ? 'ok' : 'fail', { path: tokenPath, length: token.length }))
    } catch (error) {
      checks.push(check('web_token', 'fail', { path: tokenPath, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  let appResolved
  try {
    appResolved = await locateApp({ appPath, env })
  } catch (error) {
    appResolved = { error: error instanceof Error ? error.message : String(error) }
  }
  checks.push(
    appResolved && !appResolved.error && appResolved.command
      ? check('app_binary', 'ok', {
          command: appResolved.command,
          packaged: appResolved.packaged === true
        })
      : check('app_binary', 'warn', {
          detail: '没有定位到已安装的应用；CLI 的多数命令需要它',
          ...(appResolved && appResolved.error ? { error: appResolved.error } : {})
        })
  )

  const required = await readEnginesRequirement()
  const nodeOk = meetsRequirement(process.versions.node, required)
  checks.push(
    check('node', nodeOk === false ? 'fail' : 'ok', {
      version: process.versions.node,
      required: required ?? '未声明',
      meetsRequirement: nodeOk === undefined ? '未知（未声明要求）' : nodeOk
    })
  )

  const summary = {
    ok: checks.filter((entry) => entry.status === 'ok').length,
    warn: checks.filter((entry) => entry.status === 'warn').length,
    fail: checks.filter((entry) => entry.status === 'fail').length
  }

  return {
    configRoot: root,
    checks,
    summary,
    readiness: {
      decidedBy: 'purescience ready',
      // Said in as many words so a reader cannot mistake this report for the verdict itself.
      note:
        '就绪判定不在这里：`purescience ready` 会给出应用侧的就绪结论。本命令只报告在本机测得的事实（路径、pid、权限、版本）。'
    }
  }
}

export const formatDoctor = (report) => {
  const lines = [`PureScience doctor — config root: ${report.configRoot}`, '']
  for (const entry of report.checks) {
    const mark = entry.status === 'ok' ? 'ok  ' : entry.status === 'warn' ? 'warn' : 'FAIL'
    const evidence = Object.entries(entry.evidence)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ')
    lines.push(`  [${mark}] ${entry.check}  ${evidence}`)
  }
  lines.push('', `measured: ${String(report.summary.ok)} ok, ${String(report.summary.warn)} warn, ${String(report.summary.fail)} fail`)
  lines.push(report.readiness.note)
  return lines.join('\n')
}

// Windows accepts a POSIX mode on mkdir and then ignores it, so a message claiming "mode 0700" would be
// claiming something this platform does not do. The request is still made; only the claim is qualified.
const POSIX_MODES_ENFORCED = process.platform !== 'win32'
const describeMode = (mode) =>
  POSIX_MODES_ENFORCED
    ? `mode ${mode.toString(8).padStart(4, '0')}`
    : `mode ${mode.toString(8).padStart(4, '0')} requested, not enforced on this platform`

export const runInit = async ({ configRoot, appPath, env = process.env } = {}) => {
  const root = resolveConfigRoot({ override: configRoot, env })
  const before = await probe(root)
  const created = !before.exists
  if (created) {
    await mkdir(root, { recursive: true, mode: 0o700 })
  }

  const after = await probe(root)
  const statePath = join(root, STATE_FILE)
  const tokenPath = join(root, TOKEN_FILE)
  const contents = {
    stateFile: (await probe(statePath)).exists,
    tokenFile: (await probe(tokenPath)).exists
  }

  let appResolved
  try {
    appResolved = await locateApp({ appPath, env })
  } catch {
    appResolved = undefined
  }

  return {
    configRoot: root,
    created,
    // The root's contents are never touched: an init that overwrote a state file would be an init that
    // could break a running service.
    contentsUntouched: !created && (contents.stateFile || contents.tokenFile),
    mode: after.mode,
    contents,
    wroteSettings: false,
    nextSteps: [
      appResolved?.command
        ? `应用已就位：${String(appResolved.command)}`
        : '安装应用后重试：https://github.com/naiyixi/PureScience/releases/latest',
      'purescience doctor  — 查看本机可测事实（不做就绪判定）',
      'purescience start   — 启动后台与本地 Web',
      'purescience ready   — 由应用给出就绪结论'
    ],
    note: '本命令只创建/确认配置目录，不写入任何设置，也不覆盖已有文件。'
  }
}

export const formatInit = (result) => {
  const lines = [
    `PureScience init — config root: ${result.configRoot}`,
    result.created
      ? `  created (${describeMode(0o700)})`
      : `  already present (${describeMode(Number(result.mode) || 0o700)})`,
    `  state file: ${result.contents.stateFile ? 'present' : 'absent'} · token file: ${result.contents.tokenFile ? 'present' : 'absent'}`,
    '',
    result.note
  ]
  for (const step of result.nextSteps) lines.push(`  - ${step}`)
  return lines.join('\n')
}

// Exported for the CLI's tests, which drive these against a temporary root rather than the real one.
export const readRootContents = async (root) => ({
  state: await readFile(join(root, STATE_FILE), 'utf8').catch(() => undefined)
})
