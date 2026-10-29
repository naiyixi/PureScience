// 轨迹包（v2.19 §2）：一次会话的可复现证据，**脱敏后**的文件集合。
//
// 三件事决定了这个文件的样子：
//
// 1. 它不自己维护一份「什么是秘密」的清单。擦除与泄漏检查都来自 `diagnostics/support-bundle.ts`
//    的 `scrubText` —— 那份清单已经在生产里跑了很久（support bundle 一旦查出泄漏就删包抛错）。
//    第二份清单只会漂移，而漂移的表现是「以为擦过、其实没擦」。
// 2. 擦除作用在**对象图的字符串值**上，不是序列化之后的整段 JSON。support bundle 的那条 labelled
//    规则把「标签之后直到行尾」整段替换掉 —— 对日志行是对的，对 JSON 会把后半个对象吞掉，产出一个
//    解析不了的文件（本轮实测：`"apiKey": [REDACTED]` 少了引号与逗号）。
// 3. 「做不到就不打」是硬规则（计划 §2）：只投影会话文档里真实存在的东西；拿不到就整段不写。
//
// `includeContent: false` 保留结构、计数与哈希，丢掉正文 —— 用来看「跑没跑这个工具」，而不是
// 「模型说了什么」。

import { scrubText } from '../diagnostics/support-bundle'
import type { ToolCallReading } from '../../shared/tool-call-readings'

// 工具调用的读数形状只有一份定义（`shared/tool-call-readings.ts`）：轨迹包与会话包说的是同一件事
// ——「哪一次调用、花了多久、结果多大、结果摘要是什么」。这里保留 `TrajectoryToolCall` 这个名字，
// 因为轨迹包的清单与测试一直这么叫它；但它不再是第二份结构。
export type TrajectoryToolCall = ToolCallReading

export type TrajectoryArtifact = {
  artifactVersionId: string
  sha256?: string
  runId?: string
}

export type TrajectoryCapabilities = {
  servers: readonly string[]
  groups?: string
}

export type TrajectoryInput = {
  productVersion: string
  sessionId: string
  /** 权威会话文档（已从 `sessions:load-all` 读出）。结构保留，凭证就地替换为 `REDACTED`。 */
  session: unknown
  toolCalls?: readonly TrajectoryToolCall[]
  artifacts?: readonly TrajectoryArtifact[]
  capabilities?: TrajectoryCapabilities
  /** 默认 true。false 时正文不写，只留结构、计数与哈希。 */
  includeContent?: boolean
  /** 家目录/用户名等要擦掉的字符串（support bundle 用同一组 needles）。 */
  needles?: readonly string[]
  /** 测试缝：关掉擦除，用来证明「回读自检」真的会拒发。默认开。 */
  scrub?: boolean
  now?: () => Date
}

export type TrajectoryBundle = {
  /** 相对路径 → 内容。调用方决定写到哪。 */
  files: Record<string, string>
  /** 本次擦除了多少处（键替换 + 文本替换），0 表示这份文档本来就没有。 */
  redactions: number
  /** 有值 = 自检发现该文件仍带秘密形状，调用方必须拒发而不是落盘。 */
  leak: string | undefined
}

const SECRET_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|apiKey|api_key|keyRef|keyMask|token|accessToken|refreshToken|secret|password|clientSecret|privateKey|encryptedKey)$/iu

type Scrubber = (text: string) => string

const projectRedacted = (value: unknown, scrub: Scrubber, key?: string): unknown => {
  if (typeof value === 'string') {
    if (key && SECRET_KEY_PATTERN.test(key)) return 'REDACTED'
    return scrub(value)
  }
  if (Array.isArray(value)) return value.map((entry) => projectRedacted(entry, scrub))
  if (typeof value !== 'object' || value === null) return value

  const projected: Record<string, unknown> = {}
  for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
    projected[entryKey] = projectRedacted(entry, scrub, entryKey)
  }
  return projected
}

/**
 * How many values this projection replaced. Counted from the finished document rather than incremented
 * from callbacks: a counter that lives beside the redaction can drift from it (this module's first
 * version did exactly that — values were masked while the counter stayed at zero), whereas counting
 * `REDACTED` in the output cannot disagree with the output.
 */
const countRedacted = (value: unknown): number =>
  JSON.stringify(value)?.match(/"REDACTED"/gu)?.length ?? 0

const countMessages = (session: unknown): number => {
  const messages = (session as { messages?: unknown }).messages
  return Array.isArray(messages) ? messages.length : 0
}

const countTurnsWithUsage = (session: unknown): number => {
  const messages = (session as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return 0
  return messages.filter((message) => {
    const usage = (message as { turnUsage?: unknown }).turnUsage
    return typeof usage === 'object' && usage !== null
  }).length
}

const stripContent = (session: unknown, scrub: Scrubber): unknown => {
  const clone = projectRedacted(session, scrub) as { messages?: unknown }
  if (!Array.isArray(clone.messages)) return clone
  clone.messages = clone.messages.map((message) => {
    const record = message as Record<string, unknown>
    const { content, ...rest } = record
    return {
      ...rest,
      contentOmitted: true,
      ...(typeof content === 'string' ? { contentBytes: Buffer.byteLength(content, 'utf8') } : {})
    }
  })
  return clone
}

/**
 * Detection only. `scrubText` is line-oriented: applied to serialized JSON its own labels (`"apiKey": …`)
 * match the labelled-assignment rule, so "did a second pass change it" would report a leak for a clean
 * document. Asking each projected VALUE instead is the honest question — does any shipped string still
 * look like a secret? `REDACTED` is a fixed point; a leaked token is not.
 */
const findSecretValue = (value: unknown): boolean => {
  if (typeof value === 'string') {
    if (value === 'REDACTED') return false
    return scrubText(value, []).text !== value
  }
  if (Array.isArray(value)) return value.some((entry) => findSecretValue(entry))
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value as Record<string, unknown>).some((entry) => findSecretValue(entry))
}

const sha256Hex = async (text: string): Promise<string> => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Builds the redacted file set. Pure with respect to the filesystem (checksums are the only async part),
 * so the redaction rules are testable without a bundle, a server or a running app.
 */
export const buildTrajectoryDocuments = async (
  input: TrajectoryInput
): Promise<TrajectoryBundle> => {
  const now = input.now ?? ((): Date => new Date())
  const includeContent = input.includeContent ?? true
  const needles = input.needles ?? []
  const scrubEnabled = input.scrub ?? true
  const state = { redactions: 0 }

  const scrub: Scrubber = (text) => {
    if (!scrubEnabled) return text
    const result = scrubText(text, needles)
    state.redactions += result.redactions
    return result.text
  }

  const files: Record<string, string> = {}
  /** Documents before serialisation: the self-check walks those (see `findSecretValue`). */
  const documents: Record<string, unknown> = {}
  const putJson = (path: string, value: unknown): void => {
    documents[path] = value
    files[path] = `${JSON.stringify(value, null, 2)}\n`
  }

  putJson('manifest.json', {
    bundle: 'trajectory/1',
    generatedAt: now().toISOString(),
    productVersion: input.productVersion,
    sessionId: input.sessionId,
    includeContent,
    // 每段为什么在/不在，写在这里而不是让读者从「文件缺失」去猜：「这一段没有内容」与「这一段没采到」
    // 是两个不同的答案（本仓对空读数的一贯要求）。
    sections: {
      session: includeContent ? 'included' : 'included-without-content',
      toolCalls: input.toolCalls ? 'included' : 'absent:not-collected',
      artifacts: input.artifacts ? 'included' : 'absent:not-collected',
      capabilities: input.capabilities ? 'included' : 'absent:not-persisted'
    },
    counts: {
      messages: countMessages(input.session),
      messagesWithProviderUsage: countTurnsWithUsage(input.session),
      toolCalls: input.toolCalls?.length ?? 0,
      artifacts: input.artifacts?.length ?? 0
    }
  })

  const sessionDocument = includeContent
    ? projectRedacted(input.session, scrub)
    : stripContent(input.session, scrub)
  state.redactions += countRedacted(sessionDocument)
  putJson('session.json', sessionDocument)

  if (input.toolCalls) {
    const projectedCalls = input.toolCalls.map((call) => projectRedacted(call, scrub))
    state.redactions += countRedacted(projectedCalls)
    documents['tool-calls.jsonl'] = projectedCalls
    files['tool-calls.jsonl'] = `${projectedCalls.map((call) => JSON.stringify(call)).join('\n')}\n`
  }
  if (input.artifacts) putJson('artifacts.json', { artifacts: input.artifacts })
  if (input.capabilities) putJson('capabilities.json', input.capabilities)

  // Checksums last, over the bytes that will actually ship.
  const lines: string[] = []
  for (const path of Object.keys(files).sort()) {
    lines.push(`${await sha256Hex(files[path] ?? '')}  ${path}`)
  }
  files['checksums.sha256'] = `${lines.join('\n')}\n`

  let leak: string | undefined
  for (const [path, document] of Object.entries(documents)) {
    if (findSecretValue(document)) {
      leak = path
      break
    }
  }

  return { files, redactions: state.redactions, leak }
}
