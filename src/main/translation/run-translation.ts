// A1 第二片：把段落级检查点引擎接到**应用**上 —— 谁都能调用的一次翻译，且「续传不重翻」是它自己说的。
//
// 这一层只做接线，判断全在既有三处（`shared/translation-units.ts` 的单元与哈希配方、
// `engine.ts` 的续跑、`checkpoint-store.ts` 的落盘）；它自己不重写任何一条规则。
//
// 三条硬规矩：
//
//  1. **拿不出端点就不翻译**（`not-configured`）：没有可用的模型端点时**不写空检查点**，也不回一句
//     「翻译完成」。假装翻译过比翻译失败更糟 —— 后者可以重试，前者会让后续一切基于假数据。
//  2. **没有段落就不落盘**（`empty-source`）：一个单元都没有通常意味着这一份没有文本层（那是 A6 要
//     具名说的事），不是一个「0 段的译文」。写一个空检查点会让「没有文本层」看起来像「已翻译 0 段」。
//  3. **报告里带上真正用的模型**，且落点路径原样返回 —— 一次读数的证据是「哪个文件、哪个模型、
//     多少段复用」，不是一句「已完成」。
//
// 存储根由**调用方解析一次**传进来（与读侧同源）：这一层不自己再解析一遍根，否则写侧与读侧可能落在
// 两个不同的数据根上（本仓有过这种真缺陷）。

import type { TranslationSourceIdentity } from './checkpoint-store'
import { TranslationCheckpointStore } from './checkpoint-store'
import { runTranslation, type TranslationRunResult } from './engine'
import { createProviderTranslator, type ProviderTranslatorTarget } from './provider-translator'
import type { TranslationUnit } from '../../shared/translation-units'

export type TranslationProviderTarget = ProviderTranslatorTarget

export type TranslationTargetLookup =
  | { ok: true; target: TranslationProviderTarget }
  /** 拿不出来时的**具名**原因（由装配处给出，例如「没有配置可用的模型供应商」）。 */
  | { ok: false; detail: string }

/**
 * The wording for "there is no endpoint to translate with" — one constant, because the window's surface and
 * the agent's tool must say the same thing about the same missing setting (two copies drift, and then two
 * readings of the same installation disagree).
 */
export const TRANSLATION_TARGET_UNCONFIGURED_DETAIL =
  'No provider and model are configured for translation. Select a provider with an OpenAI-compatible endpoint in Settings, then translate again.'

/** Turns the settings service's answer into the lookup this runner takes: an endpoint, or why there is none. */
export const translationTargetLookup = (
  resolved: TranslationProviderTarget | undefined
): TranslationTargetLookup =>
  resolved
    ? { ok: true, target: resolved }
    : { ok: false, detail: TRANSLATION_TARGET_UNCONFIGURED_DETAIL }

export type TranslationRunnerDeps = {
  /** 存储根（装配处解析一次，读侧共用同一个）。 */
  storageRoot: () => string
  /** 这次翻译用哪个端点。每次调用都重新解析 —— 用户在设置里改完之后下一次翻译就该用新的。 */
  target: () => Promise<TranslationTargetLookup> | TranslationTargetLookup
  targetLanguage?: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** 一次运行最多连续失败几次就停下（默认走引擎自己的常量）。 */
  maxConsecutiveFailures?: number
  /** 每次开工前问一次：中断后就地保存，下次接着跑。 */
  shouldStop?: () => boolean
  onProgress?: (progress: {
    total: number
    translated: number
    reused: number
    failed: number
  }) => void
}

export type TranslationRunRequest = {
  source: TranslationSourceIdentity
  units: readonly TranslationUnit[]
}

/** 一次运行的结果，外加**真正用的模型**与落点（读数的证据）。 */
export type TranslationRunReport = TranslationRunResult & {
  /** 这次实际请求的模型名（端点拿不出来时不会有报告 —— 那是拒绝）。 */
  model: string
  /** 源里一个单元都没有时的具名事实（此时不落盘）。 */
  source: TranslationSourceIdentity
}

export type TranslationRunnerRefusal = 'not-configured' | 'empty-source' | 'invalid-request'

export type TranslationRunReply =
  | { ok: true; report: TranslationRunReport }
  | { ok: false; reason: TranslationRunnerRefusal; detail: string }

const isSourceUsable = (source: unknown): source is TranslationSourceIdentity => {
  if (typeof source !== 'object' || source === null) return false
  const candidate = source as Record<string, unknown>
  return (
    typeof candidate.kind === 'string' &&
    candidate.kind !== '' &&
    typeof candidate.id === 'string' &&
    candidate.id !== '' &&
    typeof candidate.contentHash === 'string' &&
    candidate.contentHash !== ''
  )
}

export const createTranslationRunner = (
  deps: TranslationRunnerDeps
): {
  run: (request: TranslationRunRequest) => Promise<TranslationRunReply>
} => ({
  async run(request: TranslationRunRequest): Promise<TranslationRunReply> {
    if (!isSourceUsable(request?.source)) {
      return {
        ok: false,
        reason: 'invalid-request',
        detail: '这次请求没说清翻的是哪一份（缺 kind / id / contentHash 之一）。'
      }
    }

    if (!Array.isArray(request.units) || request.units.length === 0) {
      // 具名拒绝，不落盘：一个空检查点会让「没有文本层」看起来像「已翻译 0 段」。
      return {
        ok: false,
        reason: 'empty-source',
        detail: '这一份里没有可翻译的段落（整篇可能都没有文本层），因此没有开始翻译、也没有落盘。'
      }
    }

    const lookup = await Promise.resolve(deps.target())
    if (!lookup.ok) {
      return { ok: false, reason: 'not-configured', detail: lookup.detail }
    }

    const store = new TranslationCheckpointStore({
      root: deps.storageRoot(),
      ...(deps.now ? { now: deps.now } : {})
    })
    const translate = createProviderTranslator(lookup.target, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.targetLanguage ? { targetLanguage: deps.targetLanguage } : {})
    })

    const result = await runTranslation({
      source: request.source,
      units: request.units,
      store,
      translate,
      ...(deps.shouldStop ? { shouldStop: deps.shouldStop } : {}),
      ...(deps.maxConsecutiveFailures !== undefined
        ? { maxConsecutiveFailures: deps.maxConsecutiveFailures }
        : {}),
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {})
    })

    return {
      ok: true,
      report: { ...result, model: lookup.target.model, source: request.source }
    }
  }
})
