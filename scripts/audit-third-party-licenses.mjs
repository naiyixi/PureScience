/* eslint-disable @typescript-eslint/explicit-function-return-type */
// 第三方许可证视图的两套独立取数（不依赖被测代码）：
//   1) 用户自己主日志里「清单读不到」警告的突发统计 —— 空结果导致对话框无限重取的那条读数。
//   2) 直接解析已安装应用的 app.asar，算「应该列出几条」的**独立期望**（不调应用自己的采集器）。
//
// 用法：
//   node scripts/audit-third-party-licenses.mjs
//   node scripts/audit-third-party-licenses.mjs --log-dir ~/Library/Logs/PureScience \
//     --asar "/Applications/PureScience.app/Contents/Resources/app.asar"
//
// 为什么两套都要：只看应用自己的采集结果，无法区分「树里真的没有可列条目」与
// 「树被找错了地方」；只看 asar 也无法证明应用读的就是这一份。

import {
  readFileSync,
  readdirSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const WARNING = 'unable to read package.json for third-party license collection'
const LICENSE_CANDIDATES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md']
const BURST_GAP_MS = 2000

const expandHome = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)

// ---------------------------------------------------------------- 日志侧

const logBursts = (logDir) => {
  if (!existsSync(logDir)) {
    console.log(`log dir missing: ${logDir}`)
    return
  }
  const files = readdirSync(logDir)
    .filter((name) => /^main(\..+)?\.log$/.test(name))
    .sort()
  let total = 0
  for (const name of files) {
    const path = join(logDir, name)
    const stamps = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes(WARNING)) continue
      try {
        const parsed = JSON.parse(line)
        if (typeof parsed.t === 'string') stamps.push(parsed.t)
      } catch {
        // not a structured line; the timestamp is unavailable, so it cannot join a burst
      }
    }
    if (stamps.length === 0) continue
    total += stamps.length
    const bursts = []
    let current = [stamps[0]]
    for (const stamp of stamps.slice(1)) {
      const gap = new Date(stamp).getTime() - new Date(current[current.length - 1]).getTime()
      if (gap > BURST_GAP_MS) {
        bursts.push(current)
        current = []
      }
      current.push(stamp)
    }
    bursts.push(current)
    console.log(`${basename(path)}: ${stamps.length} warnings, ${bursts.length} burst(s)`)
    for (const burst of bursts) {
      const span =
        (new Date(burst[burst.length - 1]).getTime() - new Date(burst[0]).getTime()) / 1000
      const rate = span > 0 ? (burst.length / span).toFixed(0) : 'n/a'
      console.log(
        `  n=${String(burst.length).padStart(5)}  start=${burst[0]}  span=${span.toFixed(3)}s  rate=${rate}/s`
      )
    }
  }
  console.log(`total warning lines: ${total}`)
}

// ---------------------------------------------------------------- asar 侧

// Reads the asar header (pickle + JSON directory tree) without any third-party dependency.
// The descriptor stays open for the caller: entry bodies live after the header, so they can only be
// read while it is open.
const openAsar = (asarPath) => {
  const size = statSync(asarPath).size
  const fd = openSync(asarPath, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonLength = head.readUInt32LE(12)
  const jsonBuffer = Buffer.alloc(jsonLength)
  readSync(fd, jsonBuffer, 0, jsonLength, 16)
  const tree = JSON.parse(jsonBuffer.toString('utf8'))
  const base = 8 + headerSize
  const readEntry = (entry) => {
    const buffer = Buffer.alloc(entry.size)
    readSync(fd, buffer, 0, entry.size, base + Number(entry.offset))
    return buffer
  }
  return { tree, readEntry, size, close: () => closeSync(fd) }
}

const asarExpectation = (asarPath) => {
  if (!existsSync(asarPath)) {
    console.log(`asar missing: ${asarPath}`)
    return
  }
  const asar = openAsar(asarPath)
  try {
    asarExpectationWith(asarPath, asar)
  } finally {
    asar.close()
  }
}

const asarExpectationWith = (asarPath, { tree, readEntry, size }) => {
  console.log(`asar: ${asarPath} (${size} bytes)`)
  const lookup = (path) => {
    let node = tree
    for (const part of path.split('/').filter(Boolean)) {
      if (!node.files || !node.files[part]) return undefined
      node = node.files[part]
    }
    return node
  }
  const manifestEntry = lookup('package.json')
  if (!manifestEntry) {
    console.log('no package.json inside the asar')
    return
  }
  const manifest = JSON.parse(readEntry(manifestEntry).toString('utf8'))
  const dependencies = Object.keys(manifest.dependencies ?? {})
  console.log(`direct dependencies declared in the packaged package.json: ${dependencies.length}`)
  let withManifest = 0
  let withLicense = 0
  const missing = []
  for (const name of dependencies) {
    if (!lookup(`node_modules/${name}/package.json`)) {
      missing.push(`${name}:no-package.json`)
      continue
    }
    withManifest += 1
    const license = LICENSE_CANDIDATES.find((candidate) =>
      lookup(`node_modules/${name}/${candidate}`)
    )
    if (license) withLicense += 1
    else missing.push(`${name}:no-LICENSE`)
  }
  console.log(`with package.json inside asar: ${withManifest}`)
  console.log(`with a LICENSE file inside asar: ${withLicense}  <-- expected entry count`)
  console.log(`missing: ${missing.length > 0 ? missing.join(', ') : '(none)'}`)
}

const logDir = expandHome(argOf('log-dir', '~/Library/Logs/PureScience'))
const asar = expandHome(argOf('asar', '/Applications/PureScience.app/Contents/Resources/app.asar'))

console.log('=== application log: "manifest unreadable" bursts ===')
logBursts(logDir)
console.log('=== installed bundle: independent expectation ===')
asarExpectation(asar)
