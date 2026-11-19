// 升级回滚：新版本起不来时，把安装目录退回上一版并重新拉起旧版本。
//
// 为什么需要它：现在的更新链路是 electron-updater 的 quitAndInstall —— 装完就重启，装上去的那一版如果**根本起不来**
// （缺文件、被安全软件拦掉、运行时缓存坏掉），用户面对的是一个再也打不开的应用，且没有任何自动退路。3.3 要的就是这条路。
//
// 设计取舍，刻意简单：
// - 更新前把整个安装目录**复制**一份当备份（不是压缩包，不是增量），恢复就是复制回去 —— 可读、可手工核对；
// - 一个标记文件描述「正在发生什么」：从哪版到哪版、备份在哪、第几次启动；
// - 真正的回滚由**独立进程**做（cli/rollback-supervisor.cjs，用应用自带的 Electron 以 Node 模式跑）。必须是独立进程：
//   如果新版本的 asar 已经坏了，App 自己的代码根本不会执行，进程内回滚是空想；
// - 健康信号是一个文件：新版本跑起来后写一下，监管进程看到就收工；等不到超时就恢复。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  cpSync,
  rmSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export type PendingUpdate = {
  fromVersion: string
  toVersion: string
  /** 安装目录（被替换的那一份）。 */
  installDir: string
  /** 上一版安装目录的完整副本。 */
  backupDir: string
  /** 新版本健康启动后写这个文件；监管进程等不到它就回滚。 */
  healthFile: string
  startedAt: number
  /** 以「新版本身份」启动了几次；超过上限由进程内兜底再回滚一次。 */
  attempts: number
}

export type RollbackPaths = {
  markerFile: string
  backupRoot: string
  healthFile: string
}

// 所有状态都放在配置根的 runtime/ 下，不碰 settings、不改 schema、不加 IPC 通道。
export const rollbackPaths = (configRoot: string): RollbackPaths => {
  const runtimeDir = join(configRoot, 'runtime')
  return {
    markerFile: join(runtimeDir, 'update-pending.json'),
    backupRoot: join(runtimeDir, 'rollback'),
    healthFile: join(runtimeDir, 'update-healthy')
  }
}

export const readPendingUpdate = (markerFile: string): PendingUpdate | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerFile, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const value = parsed as PendingUpdate
    if (
      typeof value.fromVersion !== 'string' ||
      typeof value.toVersion !== 'string' ||
      typeof value.installDir !== 'string' ||
      typeof value.backupDir !== 'string' ||
      typeof value.healthFile !== 'string'
    ) {
      return undefined
    }
    return { ...value, attempts: typeof value.attempts === 'number' ? value.attempts : 0 }
  } catch {
    // 坏标记当没有标记：一个读不懂的文件不该让应用起不来。
    return undefined
  }
}

export const writePendingUpdate = (markerFile: string, pending: PendingUpdate): void => {
  mkdirSync(dirname(markerFile), { recursive: true })
  writeFileSync(markerFile, `${JSON.stringify(pending, null, 2)}\n`)
}

/** 更新已被判定为成功：标记与健康信号都可以清掉，备份留到下一次更新时再覆盖。 */
export const clearPendingUpdate = (markerFile: string, healthFile: string): void => {
  rmSync(markerFile, { force: true })
  rmSync(healthFile, { force: true })
}

/** 把安装目录整份复制成备份；备份已存在时先删掉，避免半新半旧的混合体。 */
export const backupInstallDir = (installDir: string, backupDir: string): void => {
  rmSync(backupDir, { recursive: true, force: true })
  mkdirSync(backupDir, { recursive: true })
  cpSync(installDir, backupDir, { recursive: true, verbatimSymlinks: true })
}

/**
 * 用备份盖回去。先删安装目录再复制，而不是「覆盖复制」：新版本可能多出文件，覆盖会留下旧版本没有的残骸。
 * 备份本身保留 —— 万一恢复也失败，用户还能手工把它捞回来。
 */
export const restoreInstallDir = (installDir: string, backupDir: string): void => {
  if (!existsSync(backupDir)) throw new Error(`rollback backup missing: ${backupDir}`)
  rmSync(installDir, { recursive: true, force: true })
  mkdirSync(installDir, { recursive: true })
  cpSync(backupDir, installDir, { recursive: true, verbatimSymlinks: true })
}

export type RollbackDecision = 'none' | 'count-attempt' | 'roll-back'

/**
 * 进程内的兜底判断（监管进程是第一道）。三轮之内还没健康起来就回滚：
 * 一次失败可能是偶发（安全软件扫描、磁盘忙），连续三次同一个新版本都起不来就是它坏了。
 */
export const decideRollback = (input: {
  pending: PendingUpdate | undefined
  runningVersion: string
  maxAttempts?: number
}): RollbackDecision => {
  const { pending, runningVersion, maxAttempts = 3 } = input
  if (!pending) return 'none'
  // 标记指向的不是当前运行的版本 → 这是上一次更新留下的垃圾，或者用户手工换了版本；不动它。
  if (pending.toVersion !== runningVersion) return 'none'
  return pending.attempts >= maxAttempts ? 'roll-back' : 'count-attempt'
}

/** 新版本健康启动：写下健康信号，让监管进程收工。 */
export const markUpdateHealthy = (healthFile: string, version: string): void => {
  try {
    mkdirSync(dirname(healthFile), { recursive: true })
    writeFileSync(healthFile, `${JSON.stringify({ version, at: Date.now() })}\n`)
  } catch {
    // 写不下健康信号时什么都不做：监管进程会超时回滚，这是它的职责，不是错误。
  }
}

/** 目录里是否有东西（用来判断一个「备份」是不是空壳）。 */
export const isNonEmptyDir = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0
  } catch {
    return false
  }
}
