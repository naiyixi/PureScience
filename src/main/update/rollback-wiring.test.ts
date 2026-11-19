// 回滚接线（rollback-wiring）的判据：备份没做成就不许更新、标记写不下就退回「只备份」、
// 监管进程必须从备份目录里那份可执行文件起、启动结算按次数决定回滚。
//
// 为什么这些用例值得写：这条链路全在**正常路径之外**——它只在更新失败时运行，日常点几下根本走不到。
// 而它一旦写错，代价是不可逆的（覆盖安装目录）。所以每条分支（含「备份失败拒绝更新」「监管没起来」
// 这两个静默降级）都要有测试钉住，且断言落在**真实文件系统**上，不靠替身自述。
//
// electron 与 spawn 必须替身：这个模块在真实启动路径上无参数可注入，测试进程里也没有 Electron。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  exePath: '/opt/PureScience.app/Contents/MacOS/PureScience'
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return electronState.isPackaged
    },
    getPath: (): string => electronState.exePath
  }
}))

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

// 只有「标记写不下来」这一条分支没法用真实文件系统造（标记与备份共用同一个 runtime 目录，
// 让目录不可写会先让备份失败 ⇒ 走不到那条分支）⇒ 只替身这一个函数，其余用真实现。
vi.mock('./rollback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rollback')>()
  return { ...actual, writePendingUpdate: vi.fn(actual.writePendingUpdate) }
})

import {
  confirmUpdateHealthy,
  packagedRollbackTargets,
  prepareRollbackForUpdate,
  settleUpdateOnStartup
} from './rollback-wiring'
import { readPendingUpdate, rollbackPaths, writePendingUpdate } from './rollback'

const temp = (): string => mkdtempSync(join(tmpdir(), 'ps-rollback-wiring-'))

const seedInstall = (dir: string): void => {
  mkdirSync(join(dir, 'resources'), { recursive: true })
  writeFileSync(join(dir, 'purescience.exe'), 'v1-binary')
  writeFileSync(join(dir, 'resources', 'app.asar'), 'v1-asar')
}

type LogSpy = ReturnType<typeof vi.fn<(message: string) => void>>
type TestLog = { warn: LogSpy; info: LogSpy }

const makeLog = (): TestLog => ({
  warn: vi.fn<(message: string) => void>(),
  info: vi.fn<(message: string) => void>()
})

const pendingBase = (
  configRoot: string,
  installDir: string
): Parameters<typeof writePendingUpdate>[1] => {
  const { backupRoot, healthFile } = rollbackPaths(configRoot)
  return {
    fromVersion: '2.30.2',
    toVersion: '2.31.0',
    installDir,
    backupDir: join(backupRoot, '2.30.2'),
    healthFile,
    startedAt: 0,
    attempts: 0
  }
}

beforeEach(() => {
  electronState.isPackaged = false
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => ({ unref: vi.fn() }))
  vi.mocked(writePendingUpdate).mockClear()
})

afterEach(() => {
  electronState.isPackaged = false
  Reflect.deleteProperty(process, 'resourcesPath')
  vi.mocked(writePendingUpdate).mockReset()
})

describe('prepareRollbackForUpdate', () => {
  it('backs the install up, writes the marker, and arms the watchdog from the backup copy', () => {
    const root = temp()
    const configRoot = join(root, 'config')
    const installDir = join(root, 'app')
    seedInstall(installDir)
    const log = makeLog()

    const proceed = prepareRollbackForUpdate({
      configRoot,
      fromVersion: '2.30.2',
      toVersion: '2.31.0',
      installDir,
      exePath: join(installDir, 'purescience.exe'),
      supervisorScript: '/res/cli/rollback-supervisor.cjs',
      healthTimeoutMs: 60_000,
      log
    })

    expect(proceed).toBe(true)
    const { markerFile, backupRoot, healthFile } = rollbackPaths(configRoot)
    const backupDir = join(backupRoot, '2.30.2')
    // 备份是整份复制，不是只记原路径
    expect(readFileSync(join(backupDir, 'resources', 'app.asar'), 'utf8')).toBe('v1-asar')
    expect(readPendingUpdate(markerFile)).toMatchObject({
      fromVersion: '2.30.2',
      toVersion: '2.31.0',
      installDir,
      backupDir,
      healthFile,
      attempts: 0
    })

    // 监管进程必须从**备份里的那一份**可执行文件起：回滚要覆盖安装目录，
    // 而 Windows 不允许改动正在运行的映像。这条断言就是「救生艇停在别处」这个前提。
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [exe, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { detached: boolean; stdio: string; env: Record<string, string> }
    ]
    expect(exe).toBe(join(backupDir, 'purescience.exe'))
    expect(args).toEqual([
      '/res/cli/rollback-supervisor.cjs',
      '--marker',
      markerFile,
      '--timeout-ms',
      '60000'
    ])
    expect(options.detached).toBe(true)
    expect(options.stdio).toBe('ignore')
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('watchdog armed'))
  })

  it('falls back to the running executable when the backup carries no copy of it', () => {
    const root = temp()
    const configRoot = join(root, 'config')
    const installDir = join(root, 'app')
    seedInstall(installDir)

    // 可执行文件不在安装目录里（例如外部启动器）⇒ 备份里不会有它，只能从原位置起。
    const outsideExe = join(root, 'launcher', 'purescience')
    mkdirSync(dirname(outsideExe), { recursive: true })
    writeFileSync(outsideExe, 'launcher')

    const proceed = prepareRollbackForUpdate({
      configRoot,
      fromVersion: '2.30.2',
      toVersion: '2.31.0',
      installDir,
      exePath: outsideExe,
      supervisorScript: '/res/cli/rollback-supervisor.cjs'
    })

    expect(proceed).toBe(true)
    expect(spawnMock.mock.calls[0]?.[0]).toBe(outsideExe)
    // 没给健康超时就用默认的 180s
    const args = spawnMock.mock.calls[0]?.[1] as string[]
    expect(args[args.indexOf('--timeout-ms') + 1]).toBe('180000')
  })

  it('refuses the update when the current install cannot be backed up', () => {
    const root = temp()
    const configRoot = join(root, 'config')
    const log = makeLog()

    const proceed = prepareRollbackForUpdate({
      configRoot,
      fromVersion: '2.30.2',
      toVersion: '2.31.0',
      installDir: join(root, 'no-such-install'),
      exePath: join(root, 'no-such-install', 'purescience.exe'),
      supervisorScript: '/res/cli/rollback-supervisor.cjs',
      log
    })

    // 装一个没有退路的更新，正是这一版要消灭的处境 ⇒ 宁可这次不更新。
    expect(proceed).toBe(false)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('refusing to update'))
    expect(existsSync(rollbackPaths(configRoot).markerFile)).toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('still allows the update when only the marker cannot be written', () => {
    const root = temp()
    const configRoot = join(root, 'config')
    const installDir = join(root, 'app')
    seedInstall(installDir)
    vi.mocked(writePendingUpdate).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const log = makeLog()

    const proceed = prepareRollbackForUpdate({
      configRoot,
      fromVersion: '2.30.2',
      toVersion: '2.31.0',
      installDir,
      exePath: join(installDir, 'purescience.exe'),
      supervisorScript: '/res/cli/rollback-supervisor.cjs',
      log
    })

    // 备份已经做成了：即便没有监管进程，安装目录仍可手工/下次启动恢复，所以放行。
    expect(proceed).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('marker write failed'))
    expect(spawnMock).not.toHaveBeenCalled()
    expect(
      readFileSync(
        join(rollbackPaths(configRoot).backupRoot, '2.30.2', 'resources', 'app.asar'),
        'utf8'
      )
    ).toBe('v1-asar')
  })

  it('allows the update when the watchdog itself cannot start', () => {
    const root = temp()
    const configRoot = join(root, 'config')
    const installDir = join(root, 'app')
    seedInstall(installDir)
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn EACCES')
    })
    const log = makeLog()

    const proceed = prepareRollbackForUpdate({
      configRoot,
      fromVersion: '2.30.2',
      toVersion: '2.31.0',
      installDir,
      exePath: join(installDir, 'purescience.exe'),
      supervisorScript: '/res/cli/rollback-supervisor.cjs',
      log
    })

    // 标记已经在盘上 ⇒ 进程内兜底（settleUpdateOnStartup）仍能回滚，所以不拦更新。
    expect(proceed).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('watchdog did not start'))
    expect(existsSync(rollbackPaths(configRoot).markerFile)).toBe(true)
  })
})

describe('settleUpdateOnStartup', () => {
  it('does nothing when there is no marker, or when the marker names another version', () => {
    const root = temp()
    const configRoot = join(root, 'config')
    const installDir = join(root, 'app')
    seedInstall(installDir)

    expect(settleUpdateOnStartup({ configRoot, version: '2.31.0', installDir })).toBe('none')

    const { markerFile } = rollbackPaths(configRoot)
    writePendingUpdate(markerFile, pendingBase(configRoot, installDir))
    // 标记指向 2.31.0，而实际跑的是 2.30.2：上一次更新留下的垃圾（或用户手工换了版本），不动它。
    expect(settleUpdateOnStartup({ configRoot, version: '2.30.2', installDir })).toBe('none')
    expect(readPendingUpdate(markerFile)?.attempts).toBe(0)
  })

  it('counts attempts without writing the health signal', () => {
    const root = temp()
    const configRoot = join(root, 'config')
    const installDir = join(root, 'app')
    seedInstall(installDir)
    const { markerFile, healthFile } = rollbackPaths(configRoot)
    writePendingUpdate(markerFile, pendingBase(configRoot, installDir))

    expect(settleUpdateOnStartup({ configRoot, version: '2.31.0', installDir })).toBe(
      'count-attempt'
    )
    expect(readPendingUpdate(markerFile)?.attempts).toBe(1)
    expect(settleUpdateOnStartup({ configRoot, version: '2.31.0', installDir })).toBe(
      'count-attempt'
    )
    expect(readPendingUpdate(markerFile)?.attempts).toBe(2)
    // 主进程起来了 ≠ 应用能用：健康信号只由 confirmUpdateHealthy 在真正可用时写。
    expect(existsSync(healthFile)).toBe(false)
  })

  it('restores the previous install once the same version has failed three times', () => {
    const root = temp()
    const configRoot = join(root, 'config')
    const installDir = join(root, 'app')
    seedInstall(installDir)
    const { markerFile, backupRoot } = rollbackPaths(configRoot)
    const backupDir = join(backupRoot, '2.30.2')
    mkdirSync(backupDir, { recursive: true })
    seedInstall(backupDir)
    // 装坏的新版本：关键文件坏了，还多出一个旧版没有的文件
    rmSync(join(installDir, 'resources', 'app.asar'))
    writeFileSync(join(installDir, 'resources', 'app.asar.broken'), 'junk')
    writePendingUpdate(markerFile, { ...pendingBase(configRoot, installDir), attempts: 3 })
    const log = makeLog()

    expect(settleUpdateOnStartup({ configRoot, version: '2.31.0', installDir, log })).toBe(
      'roll-back'
    )
    expect(readFileSync(join(installDir, 'resources', 'app.asar'), 'utf8')).toBe('v1-asar')
    expect(existsSync(join(installDir, 'resources', 'app.asar.broken'))).toBe(false)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('restored 2.30.2'))
  })

  it('reports a roll-back even when the backup cannot be restored, and leaves the install alone', () => {
    const root = temp()
    const configRoot = join(root, 'config')
    const installDir = join(root, 'app')
    seedInstall(installDir)
    const { markerFile } = rollbackPaths(configRoot)
    writePendingUpdate(markerFile, { ...pendingBase(configRoot, installDir), attempts: 3 })
    const log = makeLog()

    expect(settleUpdateOnStartup({ configRoot, version: '2.31.0', installDir, log })).toBe(
      'roll-back'
    )
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('restore failed'))
    // 备份缺失时不许动手：还能跑的那一份要原封不动。
    expect(readFileSync(join(installDir, 'resources', 'app.asar'), 'utf8')).toBe('v1-asar')
  })
})

describe('confirmUpdateHealthy', () => {
  it('clears the marker once the app is usable, and does nothing when no update is pending', () => {
    const root = temp()
    const configRoot = join(root, 'config')
    const { markerFile, healthFile } = rollbackPaths(configRoot)

    confirmUpdateHealthy(configRoot, '2.31.0')
    expect(existsSync(markerFile)).toBe(false)
    expect(existsSync(healthFile)).toBe(false)

    writePendingUpdate(markerFile, pendingBase(configRoot, join(root, 'app')))
    confirmUpdateHealthy(configRoot, '2.31.0')
    expect(existsSync(markerFile)).toBe(false)
  })
})

describe('packagedRollbackTargets', () => {
  it('is undefined in development, and derives the three paths from the packaged app', () => {
    expect(packagedRollbackTargets()).toBeUndefined()

    electronState.isPackaged = true
    electronState.exePath = join('/opt/PureScience.app/Contents/MacOS', 'PureScience')
    const resourcesPath = join('/opt/PureScience.app/Contents', 'Resources')
    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesPath,
      configurable: true
    })

    const targets = packagedRollbackTargets()
    // 三条都在宿主规则下判，不写字面量分隔符：Windows 车道上 join 给出的是反斜杠。
    expect(targets?.exePath).toBe(electronState.exePath)
    expect(targets?.installDir).toBe(dirname(electronState.exePath))
    expect(targets?.supervisorScript.startsWith(resourcesPath)).toBe(true)
    expect(basename(targets?.supervisorScript ?? '')).toBe('rollback-supervisor.cjs')
    expect(targets?.supervisorScript.split(sep)).toContain('cli')
  })
})
