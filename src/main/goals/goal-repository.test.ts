// F1：目标对象的持久化。这里要证明的不是「能存能取」，而是三条会真的伤到人的性质：
//  ① 重新构造一个仓储（= 应用重启）读回来的是同一份目标；
//  ② 非法目标**一个字节都不写**（在写之前就被拒），而不是写了半条再报错；
//  ③ 一次成功的写不留临时文件（原子写的收尾），且一切落在本会话的 artifacts 目录之下。
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GOAL_MAX_MILESTONES } from '../../shared/goal'
import { GoalRepository, GoalValidationError, resolveGoalsRoot } from './goal-repository'

const roots: string[] = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'purescience-goal-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const sessionId = 'session-goal-1'

describe('goal repository', () => {
  it('returns the same goal to a fresh repository instance (a restart reads it back)', async () => {
    const root = await makeRoot()
    const first = new GoalRepository({ root, now: () => 1_700_000_000_000 })
    const written = await first.configure(sessionId, {
      objective: '把方法编译成可调用能力',
      acceptance: ['运行记录能编译成技能', '指纹稳定']
    })

    const restarted = new GoalRepository({ root })
    const read = await restarted.status(sessionId)

    expect(read).toEqual([written])
    expect(read[0]?.objective).toBe('把方法编译成可调用能力')
    expect(read[0]?.acceptance.map((item) => item.text)).toEqual([
      '运行记录能编译成技能',
      '指纹稳定'
    ])
    // Nothing is met yet: an unmet criterion is the absence of a reading reference, not a false.
    expect(read[0]?.acceptance.every((item) => item.metBy === null)).toBe(true)
  })

  it('refuses an invalid goal by name, and writes nothing at all', async () => {
    const root = await makeRoot()
    const repository = new GoalRepository({ root })

    const cases: { request: Parameters<GoalRepository['configure']>[1]; code: string }[] = [
      {
        request: { objective: '   ', acceptance: ['x'] },
        code: 'empty-objective'
      },
      {
        request: { objective: '目标', acceptance: [] },
        code: 'no-acceptance'
      },
      {
        request: { objective: '目标', acceptance: ['ok', '  '] },
        code: 'empty-acceptance-item'
      },
      {
        request: { objective: 'x'.repeat(2_001), acceptance: ['ok'] },
        code: 'objective-too-long'
      },
      {
        request: {
          objective: '目标',
          acceptance: Array.from({ length: 13 }, (_, index) => `c${index}`)
        },
        code: 'too-many-acceptance'
      }
    ]

    for (const testCase of cases) {
      await expect(repository.configure(sessionId, testCase.request)).rejects.toMatchObject({
        code: testCase.code
      })
    }

    // The decisive half: a refused configure leaves no record behind, so a later read cannot report a goal
    // that was never accepted.
    await expect(repository.status(sessionId)).resolves.toEqual([])
    await expect(readdir(join(root, 'artifacts', sessionId, '.goals'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('keeps a criterion its id across an update, so its reading cannot be orphaned', async () => {
    const root = await makeRoot()
    const repository = new GoalRepository({ root })
    const created = await repository.configure(sessionId, {
      objective: '目标',
      acceptance: ['第一条', '第二条']
    })
    const updated = await repository.configure(sessionId, {
      goalId: created.id,
      objective: '目标（改）',
      acceptance: ['第一条', '第三条']
    })

    expect(updated.id).toBe(created.id)
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.acceptance.map((item) => item.text)).toEqual(['第一条', '第三条'])
    // The kept criterion keeps its id — that id is what a reading reference hangs off.
    expect(updated.acceptance[0]?.id).toBe(created.acceptance[0]?.id)
    // The newcomer gets its own id and starts unmet.
    expect(updated.acceptance[1]?.id).not.toBe(created.acceptance[1]?.id)
    expect(updated.acceptance[1]?.metBy).toBeNull()
  })

  it('leaves no temporary file behind, and stores everything under the session artifacts directory', async () => {
    const root = await makeRoot()
    const repository = new GoalRepository({ root })
    await repository.configure(sessionId, { objective: '目标', acceptance: ['ok'] })

    const directory = join(root, 'artifacts', sessionId, '.goals')
    const entries = await readdir(directory)
    expect(entries).toEqual(['goals.json'])

    const resolved = resolveGoalsRoot(root, sessionId)
    expect(resolved.startsWith(resolve(root))).toBe(true)

    // A file that will not parse is named rather than read as "no goals".
    await writeFile(join(directory, 'goals.json'), '{ not json', 'utf8')
    await expect(repository.status(sessionId)).rejects.toMatchObject({ code: 'record-unreadable' })
  })

  it('reports an unreadable record differently from an absent one', async () => {
    const root = await makeRoot()
    const repository = new GoalRepository({ root })
    await expect(repository.status('never-used')).resolves.toEqual([])
    expect(new GoalValidationError('not-found', 'x').code).toBe('not-found')
  })
})

// F2：进度只能由读数推进。这里证明的是**主张不算数**：读不出来的读数 ⇒ 一个字节都不写；
// 读出来了 ⇒ 落盘的是**解析器算出的**指纹，而不是调用方声称的那个。
// 测试里的解析器是这条缝上的替身；生产适配器（去应用的运行记录/产物库里真查）是**具名的下一步**。
describe('goal progress (F2)', () => {
  const reading = { kind: 'run' as const, id: 'run-1', fingerprint: 'fp-real' }

  it('marks the criterion met with the fingerprint the resolver computed, not the one claimed', async () => {
    const root = await makeRoot()
    const repository = new GoalRepository({ root, now: () => 1_700_000_100_000 })
    const goal = await repository.configure(sessionId, {
      objective: '目标',
      acceptance: ['第一条', '第二条']
    })

    const updated = await repository.advance(
      sessionId,
      {
        goalId: goal.id,
        criterion: '第一条',
        note: '跑了一次并留下记录',
        // 调用方声称的指纹是假的：解析器说真话，落盘的必须是解析器的那个。
        reading: { ...reading, fingerprint: 'fp-claimed-by-caller' }
      },
      { resolve: async () => ({ ok: true, fingerprint: 'fp-real' }) }
    )

    expect(updated.acceptance[0]?.metBy).toEqual({
      kind: 'run',
      id: 'run-1',
      fingerprint: 'fp-real'
    })
    expect(updated.acceptance[1]?.metBy).toBeNull()
    expect(updated.milestones).toHaveLength(1)
    expect(updated.milestones[0]?.text).toBe('跑了一次并留下记录')
    expect(updated.milestones[0]?.reading.fingerprint).toBe('fp-real')

    // 重启后仍是同一份（含那条读数）。
    const restarted = await new GoalRepository({ root }).status(sessionId)
    expect(restarted[0]).toEqual(updated)
  })

  it('writes nothing at all when the reading cannot be resolved', async () => {
    const root = await makeRoot()
    const repository = new GoalRepository({ root })
    const goal = await repository.configure(sessionId, {
      objective: '目标',
      acceptance: ['第一条']
    })
    const path = join(root, 'artifacts', sessionId, '.goals', 'goals.json')
    const before = await readFile(path, 'utf8')

    const cases: {
      resolve: () => Promise<{
        ok: false
        reason: 'not-found' | 'foreign-session' | 'fingerprint-mismatch'
      }>
      code: string
    }[] = [
      { resolve: async () => ({ ok: false, reason: 'not-found' }), code: 'reading-not-found' },
      {
        resolve: async () => ({ ok: false, reason: 'foreign-session' }),
        code: 'reading-foreign-session'
      },
      {
        resolve: async () => ({ ok: false, reason: 'fingerprint-mismatch' }),
        code: 'reading-fingerprint-mismatch'
      }
    ]
    for (const testCase of cases) {
      await expect(
        repository.advance(sessionId, { goalId: goal.id, criterion: '第一条', reading }, testCase)
      ).rejects.toMatchObject({ code: testCase.code })
    }

    // 决定性的一半：三次拒绝之后，盘上的字节与拒绝之前**逐字符相同**。
    const after = await readFile(path, 'utf8')
    expect(after).toBe(before)
    const goals = await repository.status(sessionId)
    expect(goals[0]?.acceptance[0]?.metBy).toBeNull()
    expect(goals[0]?.milestones).toEqual([])
  })

  it('refuses malformed references, unknown criteria and unknown goals by name', async () => {
    const root = await makeRoot()
    const repository = new GoalRepository({ root })
    const goal = await repository.configure(sessionId, {
      objective: '目标',
      acceptance: ['第一条']
    })
    const ok = { resolve: async () => ({ ok: true as const, fingerprint: 'fp' }) }

    await expect(
      repository.advance(
        sessionId,
        { goalId: goal.id, criterion: '第一条', reading: { ...reading, id: '  ' } },
        ok
      )
    ).rejects.toMatchObject({ code: 'empty-reading-id' })
    await expect(
      repository.advance(
        sessionId,
        { goalId: goal.id, criterion: '第一条', reading: { ...reading, fingerprint: '' } },
        ok
      )
    ).rejects.toMatchObject({ code: 'empty-reading-fingerprint' })
    await expect(
      repository.advance(sessionId, { goalId: goal.id, criterion: '没有这条', reading }, ok)
    ).rejects.toMatchObject({ code: 'criterion-not-found' })
    await expect(
      repository.advance(sessionId, { goalId: 'no-such-goal', criterion: '第一条', reading }, ok)
    ).rejects.toMatchObject({ code: 'not-found' })

    // 按 id 也能命中同一条。
    const criterionId = (await repository.status(sessionId))[0]?.acceptance[0]?.id ?? ''
    const advanced = await repository.advance(
      sessionId,
      { goalId: goal.id, criterion: criterionId, reading },
      ok
    )
    expect(advanced.acceptance[0]?.metBy).not.toBeNull()
  })

  it('keeps at most the milestone cap, refusing the one past it', async () => {
    const root = await makeRoot()
    const repository = new GoalRepository({ root })
    const goal = await repository.configure(sessionId, {
      objective: '目标',
      acceptance: ['第一条']
    })
    const ok = { resolve: async () => ({ ok: true as const, fingerprint: 'fp' }) }
    for (let index = 0; index < GOAL_MAX_MILESTONES; index += 1) {
      await repository.advance(sessionId, { goalId: goal.id, criterion: '第一条', reading }, ok)
    }
    await expect(
      repository.advance(sessionId, { goalId: goal.id, criterion: '第一条', reading }, ok)
    ).rejects.toMatchObject({ code: 'too-many-milestones' })
    const goals = await repository.status(sessionId)
    expect(goals[0]?.milestones).toHaveLength(GOAL_MAX_MILESTONES)
  })
})
