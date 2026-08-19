/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

// Starts electron-vite dev with the localhost web service enabled. Use --headless to skip the
// initial Electron window while keeping the tray, agent runtime, and web UI available.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const DEFAULT_WEB_PORT = '44100'

// Builds the electron-vite invocation from argv/env: default the web port when unset and forward
// --headless through electron-vite's `--` passthrough. Pure so it can be unit-tested without spawning.
const buildDevWebCommand = (argv, env) => {
  const headless = argv.includes('--headless')
  const nextEnv = { ...env }
  if (!nextEnv.PURESCIENCE_WEB_PORT?.trim()) {
    nextEnv.PURESCIENCE_WEB_PORT = DEFAULT_WEB_PORT
  }
  const args = ['electron-vite', 'dev']
  // Pass a namespaced flag to Electron: Chromium consumes a literal `--headless` and renders native
  // menus (like the tray context menu) invisibly on Windows (electron/electron#48982).
  // 8GB 机器: 命令行级 js-flags 提高主进程 V8 堆 (index.ts 的 appendSwitch 在 dev 模式下不生效)
  if (headless) {
    args.push(
      '--',
      '--purescience-headless',
      // 8GB 机器实测: 大堆(4GB+)在物理内存耗尽时 SIGTRAP/OOM 崩溃更频繁;
      // 默认 2GB 堆 + 频繁 GC 反而能完成长任务, 故不设 js-flags。
      '--disable-gpu' // 省 GPU 进程内存
    )
  }
  return { command: 'npx', args, env: nextEnv }
}

const main = () => {
  const { command, args, env } = buildDevWebCommand(process.argv, process.env)
  const result = spawnSync(command, args, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32'
  })
  process.exit(result.status ?? 1)
}

if (require.main === module) main()

module.exports = { buildDevWebCommand, DEFAULT_WEB_PORT }
