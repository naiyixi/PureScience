/**
 * D6 第二半：**远程结构加载**的判据层（纯函数、无 IO）。
 *
 * 三条硬规矩，都写在类型与签名里，而不是散在调用点：
 *
 * 1. **渲染端不点名目标。** 入参只有一个 PDB id，URL 由**固定模板**在本模块拼出来 —— 渲染端永远送不了
 *    host、也送不了整条 URL。让渲染端点名目标等于把主进程的出网能力借给渲染层，而写路径的闸门
 *    拦不住一条读（它会带着应用的 UA 与凭据出去）。
 * 2. **判据复用既有那一套**：内置出网禁运名单（无条件，压过白名单）→ 出网白名单（未命中即拒）→
 *    执行保护三态（拿不出强制力时**问用户**）。不新造第二套词汇 —— 本仓「出网三态」有且只有
 *    `EXECUTION_PROTECTION_LEVELS` 这一处。
 * 3. **失败具名。** 每一种失败分开命名，绝不用一句「加载失败」把「id 不合法」「目的地不在白名单」
 *    「用户拒绝」「源上没有这一条」混成一个 —— 四件事的修法完全不同。
 */

import { isHostAllowed, isHostDenied } from './egress'
import type { ExecutionProtectionLevel } from './execution-protection'

/** 固定模板的那一台主机（也是白名单判定的对象）：PDB 文本的官方发布点。 */
export const STRUCTURE_REMOTE_HOST = 'files.rcsb.org'

/** 一次加载的文本上限：超过就当「不是一份结构文件」处理，不把内存交给远端决定。 */
export const STRUCTURE_REMOTE_MAX_BYTES = 8 * 1024 * 1024

/** PDB id 的形状（4 位：数字开头 + 3 位字母数字）。校验在**主进程**做，渲染层送的只是候选。 */
const PDB_ID_PATTERN = /^[0-9][A-Za-z0-9]{3}$/

export const STRUCTURE_REMOTE_REFUSALS = [
  /** id 形状不对（不是 4 位 PDB id）。 */
  'invalid-id',
  /** 目的地在内置出网禁运名单上（无条件拒绝，压过白名单）。 */
  'denied-host',
  /** 目的地不在出网白名单上。 */
  'not-allowlisted',
  /** 用户在看板上拒绝了这次加载。 */
  'approval-denied',
  /** 源上没有这一条（HTTP 404 一类）。 */
  'not-found',
  /** 超过文本上限。 */
  'too-large',
  /** 网络层失败（DNS/连接/超时）。与上面几种分开：它是环境问题，重试可能有用。 */
  'network-failed',
  /** 取回来了、也批准了，但**落盘失败** —— 单独具名，不把它说成网络问题。 */
  'write-failed',
  /** 这个实例里没有可用的加载器（装配处没注入）。**不假装是审批拒绝**，也不静默不动作。 */
  'not-configured'
] as const

export type StructureRemoteRefusal = (typeof STRUCTURE_REMOTE_REFUSALS)[number]

export type StructureRemoteLoadResult =
  | {
      ok: true
      pdbId: string
      fileName: string
      host: string
      /** 落盘后的绝对路径：渲染层拿它按普通文件开页签（内容由主进程按路径读，不回传整份文本）。 */
      path: string
      bytes: number
    }
  | { ok: false; reason: StructureRemoteRefusal; detail: string }

export type StructureRemoteDecision =
  | { decision: 'allow'; detail: string }
  | { decision: 'ask'; detail: string }
  | { decision: 'deny'; reason: StructureRemoteRefusal; detail: string }

/** id 规范化：裁空白、大写化；形状不对 ⇒ `undefined`（**不猜**、也不去截断成 4 位）。 */
export const normalizeStructureRemotePdbId = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined
  const candidate = raw.trim().toUpperCase()
  return PDB_ID_PATTERN.test(candidate) ? candidate : undefined
}

/** 固定模板：调用方（主进程）只拿得到这一条 URL。 */
export const structureRemoteUrl = (pdbId: string): string =>
  `https://${STRUCTURE_REMOTE_HOST}/view/${pdbId}.pdb`

/** 落到会话工作区时用的文件名。 */
export const structureRemoteFileName = (pdbId: string): string => `${pdbId}.pdb`

/**
 * 判决（纯函数，调用方把**事实**传进来）：
 *  - `allowlist === undefined` = 闸门关着（不限制）；
 *  - `protection` = 该 surface 的执行保护级别（复用既有三态词汇）。
 *
 * 顺序是有意的：**禁运名单先于白名单**（无条件）；**白名单未命中先于三态**（被挡住的去处不需要问用户
 * ——问也无用）；最后才是「拿不出强制力 ⇒ 问」。
 */
export const decideStructureRemoteLoad = (input: {
  allowlist: readonly string[] | undefined
  protection: ExecutionProtectionLevel
  host?: string
}): StructureRemoteDecision => {
  const host = input.host ?? STRUCTURE_REMOTE_HOST

  if (isHostDenied(host)) {
    return {
      decision: 'deny',
      reason: 'denied-host',
      detail: `${host} 在内置出网禁运名单上，任何情况下都不允许访问。`
    }
  }

  if (input.allowlist !== undefined && !isHostAllowed(host, [...input.allowlist])) {
    return {
      decision: 'deny',
      reason: 'not-allowlisted',
      detail: `${host} 不在出网白名单上 —— 请先在设置里把它（或域名组）加进白名单，而不是重试。`
    }
  }

  if (input.protection === 'unprotected') {
    return {
      decision: 'ask',
      detail: `本机（或该 surface）的执行隔离拿不出强制力（${input.protection}），这次外部请求要由你点头。`
    }
  }

  if (input.allowlist === undefined) {
    return {
      decision: 'ask',
      detail: '出网白名单没有开启（闸门关着），这次外部请求要由你点头。'
    }
  }

  return {
    decision: 'allow',
    detail: `${host} 在白名单上，且当前保护级别（${input.protection}）由系统强制。`
  }
}
