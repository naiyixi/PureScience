#!/usr/bin/env node
// 回滚监管进程：更新器在装包前把它拉起来，它等新版本的健康信号；等不到就把安装目录换成备份并重新拉起旧版本。
//
// 它必须是**独立进程**，理由不是洁癖：新版本的 asar 一旦坏了，App 自己的主进程根本不会执行，进程内回滚是空想。
// 这里只用 Node 内建模块，由应用自带的 Electron 以 Node 模式（ELECTRON_RUN_AS_NODE=1）跑，所以安装包里不需要再带一个运行时。
//
// 用法：
//   pureScience.exe (ELECTRON_RUN_AS_NODE=1) rollback-supervisor.cjs --marker <file> --timeout-ms 120000
//
// 结果用一行 JSON 打到 stdout，便于验收脚本与日志直接读：
//   {"outcome":"healthy"} | {"outcome":"rolled-back","restoredFrom":...} | {"outcome":"error","error":...}
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}

// Windows 上 Electron 是 GUI 子系统程序，标准输出不会回到父控制台 —— 结论必须落文件：
// 与标记同目录的 <marker>.result.json，验收脚本与排障都读这个。
const resultFile = () => (markerFile ? `${markerFile}.result.json` : undefined)

const emit = (payload) => {
  const file = resultFile()
  if (file) {
    try {
      fs.writeFileSync(file, `${JSON.stringify({ ...payload, at: Date.now() }, null, 2)}\n`)
    } catch {
      // 写不下就只剩退出码
    }
  }
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  } catch {
    // stdout 不可写（被父进程回收）时不再挣扎，退出码仍然说明结果。
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const markerFile = arg('marker')
const timeoutMs = Number(arg('timeout-ms', '120000'))
const pollMs = Number(arg('poll-ms', '1000'))

const readMarker = () => {
  try {
    return JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch {
    return undefined
  }
}

const restore = (marker) => {
  const { installDir, backupDir } = marker
  if (!fs.existsSync(backupDir)) throw new Error(`backup missing: ${backupDir}`)
  // 不能「先删目录再复制」：这个进程本身就是从安装目录里的可执行文件拉起来的，Windows 上删自己的安装目录会失败
  // （实测: 回滚进程当场报错退出，安装目录原地不动）。改成覆盖复制，再清掉备份里没有的多余条目，占用中的跳过。
  fs.mkdirSync(installDir, { recursive: true })
  fs.cpSync(backupDir, installDir, { recursive: true, force: true, verbatimSymlinks: true })
  // 递归清掉备份里没有的条目（新版本多出来的残骸可能在子目录里），被占用的跳过。
  const prune = (dir, referenceDir) => {
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(dir, entry)
      const reference = path.join(referenceDir, entry)
      if (!fs.existsSync(reference)) {
        try {
          fs.rmSync(target, { recursive: true, force: true })
        } catch {
          // 被占用就留着，下次启动再说
        }
        continue
      }
      try {
        if (fs.statSync(target).isDirectory() && fs.statSync(reference).isDirectory()) {
          prune(target, reference)
        }
      } catch {
        // 读不动就绕开
      }
    }
  }
  prune(installDir, backupDir)
}

const relaunch = (marker) => {
  // 旧版本的可执行文件就在安装目录里；用备份恢复后就地拉起它。
  const exeName = process.platform === 'win32' ? 'purescience.exe' : 'PureScience'
  const exe = path.join(marker.installDir, exeName)
  if (!fs.existsSync(exe)) return false
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
  child.unref()
  return true
}

const main = async () => {
  if (!markerFile) {
    emit({ outcome: 'error', error: 'missing --marker' })
    process.exit(64)
  }
  const marker = readMarker()
  if (!marker) {
    // 没有标记（更新被取消/已完成并清理）→ 什么都不做，正常退出。
    emit({ outcome: 'healthy', reason: 'no-pending-marker' })
    process.exit(0)
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(marker.healthFile)) {
      emit({ outcome: 'healthy', version: marker.toVersion })
      process.exit(0)
    }
    // 标记被清掉也意味着更新已判定成功（清理发生在健康信号之后）。
    if (!fs.existsSync(markerFile)) {
      emit({ outcome: 'healthy', reason: 'marker-cleared' })
      process.exit(0)
    }
    await sleep(pollMs)
  }

  restore(marker)
  const relaunched = relaunch(marker)
  // 回滚完成：把标记改成「已回滚」，让下一次启动不再把旧版本当成「待验证的新版本」。
  try {
    fs.writeFileSync(
      markerFile,
      `${JSON.stringify({ ...marker, attempts: 0, rolledBackAt: Date.now(), rolledBackTo: marker.fromVersion }, null, 2)}\n`
    )
  } catch {
    // 写不下也照实报告回滚成功——文件只是记录，恢复才是事实。
  }
  emit({
    outcome: 'rolled-back',
    restoredFrom: marker.backupDir,
    version: marker.fromVersion,
    relaunched
  })
  process.exit(0)
}

main().catch((error) => {
  emit({ outcome: 'error', error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
