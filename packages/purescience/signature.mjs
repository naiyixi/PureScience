/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

// G1 的非花钱半边：这一版没有 Apple Developer ID，也没有 Windows 代码签名证书。
//
// 「装不上」和「装得上但系统不认发布者」是两种完全不同的处境，用户必须能从 CLI 一眼看出自己
// 在哪一种里。所以这里报告的是**本机实测**的签名状态，而不是一句「未签名」的断言：
//   · macOS：`codesign -dv` 读签名类型（Developer ID / adhoc / 无），`spctl --assess` 读 Gatekeeper 的判决；
//   · Windows：Authenticode 状态（Valid / NotSigned / UnknownError…）；
//   · Linux：没有代码签名这一层 —— 明确说「不适用」，不写成「未签名」。
//
// 每种状态都带一句**下一步怎么走**：被 Gatekeeper / SmartScreen 拦下时该点哪里。这不是安慰文案，
// 是安装流程的一部分 —— 没有它，用户看到的就是「打不开」。
const run = promisify(execFile)

const MAC_FIRST_LAUNCH =
  '首次打开会被 Gatekeeper 拦下：在「系统设置 → 隐私与安全性」页底部点「仍要打开」（或对应用右键 → 打开）。之后不再询问。'
const WINDOWS_FIRST_LAUNCH =
  '首次运行会出现 SmartScreen「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」。之后不再询问。'

/** macOS 的可执行文件在 `.app` 包里；签名与 Gatekeeper 都针对那个包，不是里面的二进制。 */
const macBundleRoot = (command) => {
  const marker = command.indexOf('.app/')
  return marker === -1 ? undefined : command.slice(0, marker + '.app'.length)
}

const parseCodesign = (text) => {
  const authority = /Authority=(.+)/.exec(text)?.[1]?.trim()
  if (/Signature=adhoc/.test(text) || /flags=0x[0-9a-f]*adhoc/i.test(text)) {
    return { kind: 'adhoc' }
  }
  if (authority) return { kind: 'signed', authority }
  return { kind: 'unsigned' }
}

const macSignature = async (command, exec, exists) => {
  const bundle = macBundleRoot(command)
  if (!bundle || !exists(bundle)) {
    return { state: 'development', detail: '不是 .app 包（开发运行），没有可评估的发布签名' }
  }
  let codesignText = ''
  try {
    // codesign writes its description to stderr even on success.
    const result = await exec('codesign', ['-dv', '--verbose=2', bundle])
    codesignText = `${result.stdout ?? ''}${result.stderr ?? ''}`
  } catch (error) {
    codesignText = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
  }
  const parsed = parseCodesign(codesignText)
  if (parsed.kind === 'signed') {
    return {
      state: 'developer-id',
      authority: parsed.authority,
      bundle,
      detail: '已用证书签名：系统能说出发布者是谁'
    }
  }
  // Gatekeeper's own verdict, asked of the system rather than inferred from `codesign`.
  let gatekeeper = 'unknown'
  try {
    await exec('spctl', ['--assess', '--type', 'execute', '-vv', bundle])
    gatekeeper = 'accepted'
  } catch (error) {
    const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
    gatekeeper = /rejected/.test(text) ? 'rejected' : 'unknown'
  }
  return {
    state: parsed.kind === 'adhoc' ? 'adhoc' : 'unsigned',
    bundle,
    gatekeeper,
    detail: MAC_FIRST_LAUNCH
  }
}

const windowsSignature = async (command, exec) => {
  try {
    const { stdout } = await exec('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-AuthenticodeSignature -LiteralPath '${command.replace(/'/g, "''")}').Status`
    ])
    const status = String(stdout ?? '').trim()
    if (status === 'Valid') {
      return { state: 'authenticode', detail: 'Authenticode 签名有效：系统能说出发布者是谁' }
    }
    // NotSigned / UnknownError / HashMismatch / NotTrusted — all "the OS cannot vouch for this file".
    return {
      state: status === 'NotSigned' ? 'unsigned' : 'invalid',
      status,
      detail: WINDOWS_FIRST_LAUNCH
    }
  } catch (error) {
    return {
      state: 'unknown',
      detail: '读不到 Authenticode 状态（PowerShell 不可用）',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Measures what this machine can say about a build's publisher identity.
 *
 * `exec` is injected so the parsing branches are testable without the real toolchains; production passes
 * nothing and gets `child_process.execFile`.
 */
export const checkSignature = async ({
  command,
  platform = process.platform,
  exec = run,
  exists = existsSync,
  appPath
} = {}) => {
  const target = command ?? appPath
  if (!target) return { state: 'unknown', detail: '没有定位到可执行文件，无法评估签名' }
  if (platform === 'darwin') return macSignature(target, exec, exists)
  if (platform === 'win32') return windowsSignature(target, exec)
  return { state: 'not-applicable', detail: '这一平台没有代码签名这一层（Linux 包靠发行渠道校验）' }
}

export { MAC_FIRST_LAUNCH, WINDOWS_FIRST_LAUNCH, macBundleRoot, parseCodesign }
