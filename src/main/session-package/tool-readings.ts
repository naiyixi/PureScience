import { createHash } from 'node:crypto'

import { strToU8 } from 'fflate'

import {
  TOOL_CALL_READINGS_RECIPE,
  SESSION_PACKAGE_TOOL_READINGS_PATH,
  compareToolCallReadings,
  parseToolCallReadingsDocument,
  type SessionPackageToolReadings,
  type ToolCallReadingsComparison
} from '../../shared/tool-call-readings'
import { extractToolCalls } from '../trajectory/extract-tool-calls'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export type BuiltToolCallReadings = {
  /** 要写进包里的那一份（路径 + 字节）。缺席态没有文件。形状即 `SessionPackageFile`。 */
  file?: { path: string; contents: Uint8Array }
  /** 清单里声明的那句话。 */
  summary: SessionPackageToolReadings
}

/**
 * 从会话文档里抽读数并把它变成「包内文件 + 清单声明」。
 *
 * 抽取只走 `extractToolCalls` 这一个实现（轨迹包与它对同一份 `session.activities` 用同一口径），
 * 这里不重新解释 activities 的形状 —— 第二份解释迟早与第一份漂移，而漂移的表现是
 * 「包里的次数与产品里看到的不一样」。
 *
 * 三种结果分开命名：
 *   · 会话里根本没有 activities ⇒ `absent:no-tool-calls`（真的没调工具）；
 *   · 有 activities 但一条都说不出名字 ⇒ `included` + `rows: []` + `unnamed: N`（不能谎称没调过）；
 *   · 有读数 ⇒ `included`，摘要按**实际写进包的字节**算。
 */
export const buildToolCallReadings = (session: unknown): BuiltToolCallReadings => {
  const { calls, unnamed, activities } = extractToolCalls(session)
  if (activities === 0) {
    return {
      summary: {
        recipe: TOOL_CALL_READINGS_RECIPE,
        state: 'absent:no-tool-calls',
        unnamed: 0
      }
    }
  }

  const document = { recipe: TOOL_CALL_READINGS_RECIPE, rows: calls, unnamed }
  const bytes = strToU8(`${JSON.stringify(document, null, 2)}\n`)
  return {
    file: { path: SESSION_PACKAGE_TOOL_READINGS_PATH, contents: bytes },
    summary: {
      recipe: TOOL_CALL_READINGS_RECIPE,
      state: 'included',
      rows: calls.length,
      unnamed,
      sha256: sha256(bytes)
    }
  }
}

/**
 * 接收端：把清单里的声明对回包内字节。
 *
 * 摘要算在**包里那批原始字节**上（配方第 2 步），不是算在「解析后再序列化一遍」的结果上：后者
 * 只能证明这份文件等于它自己，证明不了第三方拿着字节能得出同一个值。
 */
export const verifyToolCallReadings = (
  declared: unknown,
  bytes: Uint8Array | undefined
): ToolCallReadingsComparison => {
  if (bytes === undefined)
    return compareToolCallReadings(declared, { sha256: null, document: null })
  const text = new TextDecoder().decode(bytes)
  return compareToolCallReadings(declared, {
    sha256: sha256(bytes),
    document: parseToolCallReadingsDocument(text)
  })
}
