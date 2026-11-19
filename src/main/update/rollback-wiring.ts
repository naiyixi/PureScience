// 把回滚机制接到真实的更新与启动路径上。**唯一**目的：装上去的那一版起不来时，还能退回上一版。
//
// 两步：
// 1. prepareRollbackForUpdate —— update 策略在 quitAndInstall 之前调用：备份安装目录、写标记、拉起监管进程；
// 2. settleUpdateOnStartup —— 应用启动时调用：健康了就把标记与信号清掉；同一个新版本连续起不来就自己回滚一次。
//
// 全程 best-effort（除了「备份失败就不更新」这一点）：备份失败时宁可**不装**——装一个没有退路的更新，
// 正是 3.3 要消灭的那种处境。
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  backupInstallDir,
  clearPendingUpdate,
  decideRollback,
  markUpdateHealthy,
  readPendingUpdate,
  restoreInstallDir,
  rollbackPaths,
  writePendingUpdate
} from './rollback'

export type PrepareInput = {
  configRoot: string
  fromVersion: string
  toVersion: string
  installDir: string
  /** 应用自带的 Electron 可执行文件，用来以 Node 模式跑监管脚本。 */
  exePath: string
  supervisorScript: string
  healthTimeoutMs?: number
  log?: { warn: (message: string) => void; info: (message: string) => void }
}

/**
 * 备份 + 标记 + 监管进程。返回 false 表示「这次更新不该进行」——备份没做成，就不该把一个装坏了没退路的版本推给用户。
 */
export const prepareRollbackForUpdate = (input: PrepareInput): boolean => {
  const { markerFile, backupRoot, healthFile } = rollbackPaths(input.configRoot)
  const backupDir = join(backupRoot, input.fromVersion)
  try {
    backupInstallDir(input.installDir, backupDir)
  } catch (error) {
    input.log?.warn(
      `update rollback: refusing to update because the current install could not be backed up: ${String(error)}`
    )
    return false
  }

  try {
    writePendingUpdate(markerFile, {
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      installDir: input.installDir,
      backupDir,
      healthFile,
      startedAt: Date.now(),
      attempts: 0
    })
  } catch (error) {
    input.log?.warn(
      `update rollback: marker write failed, continuing without watchdog: ${String(error)}`
    )
    return true
  }

  try {
    // 独立进程：新版本的 asar 一旦坏了，App 自己的代码根本不会跑，进程内回滚是空想。
    //
    // 而且必须从**备份目录**里那份可执行文件启动，不能用安装目录里那个：回滚要覆盖安装目录里的 purescience.exe，
    // 而 Windows 不允许改动正在运行的映像（实测: "cannot be performed on a file with a user-mapped section open"）。
    // 让救生艇停在别处，是这条链路能成立的前提。
    const supervisorExe = join(backupDir, basename(input.exePath))
    const child = spawn(
      existsSync(supervisorExe) ? supervisorExe : input.exePath,
      [
        input.supervisorScript,
        '--marker',
        markerFile,
        '--timeout-ms',
        String(input.healthTimeoutMs ?? 180_000)
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }
    )
    child.unref()
    input.log?.info(`update rollback: watchdog armed for ${input.fromVersion} → ${input.toVersion}`)
  } catch (error) {
    input.log?.warn(`update rollback: watchdog did not start: ${String(error)}`)
  }
  return true
}

export type StartupInput = {
  configRoot: string
  version: string
  installDir: string
  log?: { warn: (message: string) => void; info: (message: string) => void }
}

/**
 * 启动时结算上一次更新。返回 'healthy'（更新成功，标记已清）/ 'count-attempt' / 'roll-back' / 'none'。
 * 回滚在这里只是**兜底**：主路径是监管进程，它在新版本压根起不来时就已经动手了。
 */
export const settleUpdateOnStartup = (
  input: StartupInput
): 'none' | 'healthy' | 'count-attempt' | 'roll-back' => {
  const { markerFile } = rollbackPaths(input.configRoot)
  const pending = readPendingUpdate(markerFile)
  const decision = decideRollback({ pending, runningVersion: input.version })
  if (decision === 'none') return 'none'

  if (decision === 'count-attempt') {
    const attempts = (pending?.attempts ?? 0) + 1
    try {
      writePendingUpdate(markerFile, { ...pending!, attempts })
    } catch {
      // 数不清次数就不数——别让记账本身把启动搞挂。
    }
    // 只记账，不写健康信号：主进程起来了 ≠ 应用能用（窗口/服务还没起）。健康由 confirmUpdateHealthy
    // 在真正可用的那一刻写 —— 早了，监管进程会以为新版本好好的，坏掉的部分却还没暴露。
    return 'count-attempt'
  }

  try {
    restoreInstallDir(input.installDir, pending!.backupDir)
    input.log?.info(
      `update rollback: restored ${pending!.fromVersion} after failed update to ${input.version}`
    )
  } catch (error) {
    input.log?.warn(`update rollback: restore failed: ${String(error)}`)
  }
  return 'roll-back'
}

/** 应用进入「确实能用」的状态后调用：清理标记，把这次更新记为成功。 */
export const confirmUpdateHealthy = (configRoot: string, version: string): void => {
  const { markerFile, healthFile } = rollbackPaths(configRoot)
  if (!existsSync(markerFile)) return
  markUpdateHealthy(healthFile, version)
  clearPendingUpdate(markerFile, healthFile)
}

/** 安装目录与监管脚本在打包版里的位置；开发态返回 undefined（开发态没有更新可言）。 */
export const packagedRollbackTargets = ():
  { exePath: string; installDir: string; supervisorScript: string } | undefined => {
  if (!app.isPackaged) return undefined
  const exePath = app.getPath('exe')
  const resourcesPath = process.resourcesPath
  return {
    exePath,
    installDir: dirname(exePath),
    supervisorScript: join(resourcesPath, 'cli', 'rollback-supervisor.cjs')
  }
}
