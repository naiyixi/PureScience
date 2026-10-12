/**
 * D6 第二半：**远程结构加载**的实现层（主进程）。
 *
 * 一句话的流程：**校验 id → 判据（禁运/白名单/三态）→ 必要时问卡 → 取回 → 落进会话工作区**。
 * 每一步失败都**具名**返回（取值见 `shared/structure-remote-source.ts`），不合成一句「加载失败」。
 *
 * 两条来自本仓既有纪律的硬约束：
 *  - **目标不由渲染端指定**：URL 一律由 `structureRemoteUrl()`（固定模板）拼，入参只有 PDB id；
 *  - **闸门拿不出强制力时是「问」，不是「允许」**：判决里 `ask` 就一定要过审批卡；**没有卡片可问时拒**
 *    （fail-closed —— 与 `file:save-blob` 的导出过门同一条口径：「没人能被问」不等于「没问题」）。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { EgressSettings } from '../../shared/egress'
import { resolveEgressAllowlist } from '../../shared/egress'
import type { ExecutionProtectionLevel } from '../../shared/execution-protection'
import {
  STRUCTURE_REMOTE_HOST,
  STRUCTURE_REMOTE_MAX_BYTES,
  decideStructureRemoteLoad,
  normalizeStructureRemotePdbId,
  structureRemoteFileName,
  structureRemoteUrl,
  type StructureRemoteLoadResult
} from '../../shared/structure-remote-source'
import type { ApprovalInfo } from '../connectors/approval-broker'
import type { ApprovalDecision } from '../../shared/settings'
import { createLogger, errorLogFields } from '../logger'
import { netFetchStandard } from '../skills/net-fetch'

const log = createLogger('preview:remote-structure')

// 结果类型的**唯一定义在 shared**（窗口与主进程看到同一份）：这里只是重导出它的别名，
// 不维护第二份字面量（第二份迟早会漂）。
export type { StructureRemoteLoadResult }

export type RemoteStructureFieldFetch =
  | { ok: true; text: string }
  | { ok: false; reason: 'not-found' | 'network-failed' | 'too-large'; detail: string }

export type RemoteStructureLoaderDeps = {
  /** 出网设置（`undefined` 或缺 `enabled` ⇒ 白名单不限制，判决会转成「问」）。可以是异步的。 */
  egressSettings: () => EgressSettings | undefined | Promise<EgressSettings | undefined>
  /** 该 surface 的执行保护级别（复用既有三态词汇，不另造）。 */
  protection: () => ExecutionProtectionLevel
  /** 会话工作区（应用自有目录）：取回的结构落在那里，再按普通文件开页签。 */
  workspaceFor: (sessionId: string) => string
  /** 审批卡（复用连接器那张卡的应用动作变体）。缺省 ⇒ 需要问的时候直接拒。 */
  approvals?: { request: (info: ApprovalInfo) => Promise<ApprovalDecision> }
  /** 可注入的取回实现（测试用替身）；缺省走应用自己的网络栈。 */
  fetchText?: (url: string) => Promise<RemoteStructureFieldFetch>
}

export type RemoteStructureRequest = { sessionId: string; pdbId: string }

const fetchWithAppNetworkStack = async (url: string): Promise<RemoteStructureFieldFetch> => {
  try {
    const response = await netFetchStandard(url, {
      redirect: 'follow',
      // 要的就是**结构文本**：Accept 写明 PDB/纯文本，别让服务端按 HTML 回。
      headers: { accept: 'chemical/x-pdb,text/plain;q=0.9,*/*;q=0.5' }
    })
    if (response.status === 404) {
      return { ok: false, reason: 'not-found', detail: `${url} 上没有这一条（HTTP 404）。` }
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: 'network-failed',
        detail: `${url} 返回 HTTP ${response.status}。`
      }
    }
    // 先看声明长度再读正文：超限时不必把整份内容拉进内存。
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > STRUCTURE_REMOTE_MAX_BYTES) {
      return {
        ok: false,
        reason: 'too-large',
        detail: `这一份有 ${declared} 字节，超过上限 ${STRUCTURE_REMOTE_MAX_BYTES}。`
      }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > STRUCTURE_REMOTE_MAX_BYTES) {
      return {
        ok: false,
        reason: 'too-large',
        detail: `这一份有 ${buffer.byteLength} 字节，超过上限 ${STRUCTURE_REMOTE_MAX_BYTES}。`
      }
    }
    return { ok: true, text: buffer.toString('utf8') }
  } catch (error) {
    return {
      ok: false,
      reason: 'network-failed',
      detail: `${url} 取不回来：${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export const createRemoteStructureLoader = (
  deps: RemoteStructureLoaderDeps
): {
  load: (request: RemoteStructureRequest) => Promise<StructureRemoteLoadResult>
} => {
  const fetchText = deps.fetchText ?? fetchWithAppNetworkStack

  return {
    async load(request: RemoteStructureRequest): Promise<StructureRemoteLoadResult> {
      const pdbId = normalizeStructureRemotePdbId(request.pdbId)
      if (!pdbId) {
        return {
          ok: false,
          reason: 'invalid-id',
          detail: `「${String(request.pdbId ?? '')}」不是 4 位 PDB id（形如 1CRN、7VH8）。`
        }
      }

      const decision = decideStructureRemoteLoad({
        allowlist: resolveEgressAllowlist(await Promise.resolve(deps.egressSettings())),
        protection: deps.protection()
      })
      if (decision.decision === 'deny') {
        return { ok: false, reason: decision.reason, detail: decision.detail }
      }
      if (decision.decision === 'ask') {
        // 拿不出强制力 ⇒ 必须有人点头；没有人能点头就拒（不把「问不到」当「可以」）。
        if (!deps.approvals) {
          return {
            ok: false,
            reason: 'approval-denied',
            detail: `${decision.detail} 这次没有可用的审批卡，因此不放行。`
          }
        }
        const fileName = structureRemoteFileName(pdbId)
        const approved = await deps.approvals.request({
          connector: 'structure-view',
          method: 'load-remote-structure',
          argsPreview: pdbId,
          availableScopes: ['once'],
          appAction: {
            surface: 'structure-view',
            action: 'load-remote-structure',
            writes: [{ kind: 'structure-file', fileName, extension: 'pdb' }]
          }
        })
        if (approved === 'deny') {
          return {
            ok: false,
            reason: 'approval-denied',
            detail: '你在看板上拒绝了这次加载，没有取回任何内容。'
          }
        }
      }

      const url = structureRemoteUrl(pdbId)
      const fetched = await fetchText(url)
      if (!fetched.ok) return { ok: false, reason: fetched.reason, detail: fetched.detail }

      const fileName = structureRemoteFileName(pdbId)
      const directory = deps.workspaceFor(request.sessionId)
      const path = join(directory, fileName)
      try {
        await mkdir(directory, { recursive: true })
        await writeFile(path, fetched.text, 'utf8')
      } catch (error) {
        log.warn('remote structure could not be written into the session workspace', {
          pdbId,
          ...errorLogFields(error)
        })
        return {
          ok: false,
          reason: 'write-failed',
          detail: `取回来了，但写进会话工作区失败：${
            error instanceof Error ? error.message : String(error)
          }`
        }
      }

      const bytes = Buffer.byteLength(fetched.text)
      log.info('remote structure loaded', { pdbId, host: STRUCTURE_REMOTE_HOST, bytes })
      return { ok: true, pdbId, fileName, host: STRUCTURE_REMOTE_HOST, path, bytes }
    }
  }
}
