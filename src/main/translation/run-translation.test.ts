import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TranslationCheckpointStore } from './checkpoint-store'
import { createTranslationRunner, type TranslationRunnerDeps } from './run-translation'
import { createHash } from 'node:crypto'
import { translationSourceHashInput } from '../../shared/translation-units'
import type { TranslationUnit } from '../../shared/translation-units'

// A1 的正题是「中断 → 重开续传，已完成段落**不重翻**」。所以这里的取回替身必须**按请求作答**：
// 一个永远回同一句的替身会让「第二次没有重新翻译」变成无法证伪的断言（复用的段落和重新翻译的段落
// 会产出同样的文本）。每段回「译:<原文>」，于是「谁被真的送出去过」可以从 fetch 的调用次数与请求体里读出来。
const makeFetch = (): ReturnType<typeof vi.fn> =>
  vi.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      model: string
      messages: { role: string; content: string }[]
    }
    const asked = body.messages.at(-1)?.content ?? ''
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: `译:${asked}` } }] })
    }
  })

const units: TranslationUnit[] = [
  { id: 'p1#1', page: 1, paragraph: 1, text: 'First paragraph.' },
  { id: 'p1#2', page: 1, paragraph: 2, text: 'Second paragraph.' },
  { id: 'p2#1', page: 2, paragraph: 1, text: 'Third paragraph.' }
]

/** 独立复算：不借应用自己的哈希助手，直接用 node:crypto 算公开配方。 */
const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex')

const source = { kind: 'pdf', id: 'paper-1', contentHash: 'hash-1' }
const target = {
  url: 'https://api.deepseek.com/v1/chat/completions',
  key: 'k',
  model: 'deepseek-chat'
}

describe('翻译运行器（A1：段落级记录 + 续传不重翻）', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'purescience-translation-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const runner = (overrides: Partial<TranslationRunnerDeps> = {}): ReturnType<typeof createTranslationRunner> =>
    createTranslationRunner({
      storageRoot: () => root,
      target: () => ({ ok: true, target }),
      fetchImpl: makeFetch() as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
      ...overrides
    })

  it('首次运行：每段一次请求，记录里带段落 id + 页码 + 原文哈希', async () => {
    const fetchImpl = makeFetch()
    const subject = runner({ fetchImpl })
    const reply = await subject.run({ source, units })

    expect(reply.ok).toBe(true)
    if (!reply.ok) throw new Error('unreachable')
    expect(reply.report.restored).toEqual({ state: 'none', reason: 'no-checkpoint' })
    expect(reply.report.total).toBe(3)
    expect(reply.report.translated).toBe(3)
    expect(reply.report.reused).toBe(0)
    expect(reply.report.failed).toEqual([])
    expect(reply.report.model).toBe('deepseek-chat')
    expect(fetchImpl).toHaveBeenCalledTimes(3)

    // 记录本身：id / 页码 / 原文哈希三样都在，且哈希能**按公开配方复算**。
    const raw = JSON.parse(await readFile(reply.report.checkpointPath, 'utf8')) as {
      records: Record<string, { page: number; sourceHash: string; status: string; text?: string }>
    }
    const first = raw.records['p1#1']
    expect(first?.page).toBe(1)
    expect(first?.status).toBe('translated')
    expect(first?.text).toBe('译:First paragraph.')
    expect(first?.sourceHash).toBe(
      // 配方是公开的（shared 里的常量 + 输入函数）：主进程之外也能复算同一个哈希。
      // 这里用真实的 sha256 复算，证明写进文件的确实是「原文的哈希」而不是别的东西。
      sha256Hex(translationSourceHashInput('p1#1', 'First paragraph.'))
    )
  })

  it('续传：同一份再跑一次，已完成段落**一次都不重发**', async () => {
    const fetchImpl = makeFetch()
    const subject = runner({ fetchImpl })

    await subject.run({ source, units })
    expect(fetchImpl).toHaveBeenCalledTimes(3)

    const second = await subject.run({ source, units })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')

    // 这三条合起来才是「已完成段落不重翻」：复用满数、没翻译、**网络一次都没再发**。
    expect(second.report.restored).toMatchObject({ state: 'partial', records: 3 })
    expect(second.report.reused).toBe(3)
    expect(second.report.translated).toBe(0)
    expect(second.report.failed).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('改了一段：只重翻那一段，其余复用', async () => {
    const fetchImpl = makeFetch()
    const subject = runner({ fetchImpl })
    await subject.run({ source, units })

    const edited = units.map((unit, index) =>
      index === 1 ? { ...unit, text: 'Second paragraph, revised.' } : unit
    )
    const second = await subject.run({ source, units: edited })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')

    expect(second.report.reused).toBe(2)
    expect(second.report.translated).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('换了一份内容（contentHash 变了）：一条记录都不复用', async () => {
    const fetchImpl = makeFetch()
    const subject = runner({ fetchImpl })
    await subject.run({ source, units })

    const third = await subject.run({
      source: { ...source, contentHash: 'hash-2' },
      units
    })
    expect(third.ok).toBe(true)
    if (!third.ok) throw new Error('unreachable')
    expect(third.report.restored).toEqual({ state: 'none', reason: 'source-content-changed' })
    expect(third.report.reused).toBe(0)
    expect(third.report.translated).toBe(3)
  })

  it('中断（shouldStop）之后就停下，下次接着跑而不是从头来', async () => {
    const fetchImpl = makeFetch()
    // 引擎在**每一段开工前**问一次 ⇒ 第一次问回「不停」，第二次问回「停」：正好翻完一段就中断。
    let asked = 0
    const stopped = runner({
      fetchImpl: makeFetch() as unknown as typeof fetch,
      shouldStop: () => asked++ >= 1
    })

    const first = await stopped.run({ source, units })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('unreachable')
    expect(first.report.stopped).toBe('requested')
    expect(first.report.translated).toBe(1)

    // 接上：已完成的那一段复用，剩下两段才发请求（这一次不中断）。
    const resumed = await runner({ fetchImpl }).run({ source, units })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) throw new Error('unreachable')
    expect(resumed.report.reused).toBe(1)
    expect(resumed.report.translated).toBe(2)
    expect(resumed.report.stopped).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('拿不出模型端点 ⇒ 具名 not-configured，且**一个字节都没落盘**', async () => {
    const subject = runner({
      target: () => ({ ok: false, detail: '没有配置可用的模型供应商。' })
    })
    const reply = await subject.run({ source, units })

    expect(reply.ok).toBe(false)
    if (reply.ok) throw new Error('unreachable')
    expect(reply.reason).toBe('not-configured')
    expect(reply.detail).toContain('模型供应商')
    // 拒绝必须是真的拒绝：不能留下一个空检查点让下次看起来「已经翻过」。
    await expect(access(new TranslationCheckpointStore({ root }).pathFor(source))).rejects.toThrow()
  })

  it('源里没有段落 ⇒ 具名 empty-source（没有文本层不是「已翻译 0 段」），不落盘', async () => {
    const fetchImpl = makeFetch()
    const subject = runner({ fetchImpl })
    const reply = await subject.run({ source, units: [] })

    expect(reply.ok).toBe(false)
    if (reply.ok) throw new Error('unreachable')
    expect(reply.reason).toBe('empty-source')
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(access(new TranslationCheckpointStore({ root }).pathFor(source))).rejects.toThrow()
  })

  it('请求说不清翻的是哪一份 ⇒ 具名 invalid-request', async () => {
    const subject = runner()
    const reply = await subject.run({ source: { kind: 'pdf', id: '', contentHash: 'h' }, units })
    expect(reply.ok).toBe(false)
    if (reply.ok) throw new Error('unreachable')
    expect(reply.reason).toBe('invalid-request')
  })
})
