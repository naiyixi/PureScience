// F1：目标对象的持久化。这里要证明的不是「能存能取」，而是三条会真的伤到人的性质：
//  ① 重新构造一个仓储（= 应用重启）读回来的是同一份目标；
//  ② 非法目标**一个字节都不写**（在写之前就被拒），而不是写了半条再报错；
//  ③ 一次成功的写不留临时文件（原子写的收尾），且一切落在本会话的 artifacts 目录之下。
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

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
    const written = await first.configure({
      sessionId,
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

    const cases: { request: Parameters<GoalRepository['configure']>[0]; code: string }[] = [
      {
        request: { sessionId, objective: '   ', acceptance: ['x'] },
        code: 'empty-objective'
      },
      {
        request: { sessionId, objective: '目标', acceptance: [] },
        code: 'no-acceptance'
      },
      {
        request: { sessionId, objective: '目标', acceptance: ['ok', '  '] },
        code: 'empty-acceptance-item'
      },
      {
        request: { sessionId, objective: 'x'.repeat(2_001), acceptance: ['ok'] },
        code: 'objective-too-long'
      },
      {
        request: {
          sessionId,
          objective: '目标',
          acceptance: Array.from({ length: 13 }, (_, index) => `c${index}`)
        },
        code: 'too-many-acceptance'
      }
    ]

    for (const testCase of cases) {
      await expect(repository.configure(testCase.request)).rejects.toMatchObject({
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
    const created = await repository.configure({
      sessionId,
      objective: '目标',
      acceptance: ['第一条', '第二条']
    })
    const updated = await repository.configure({
      sessionId,
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
    await repository.configure({ sessionId, objective: '目标', acceptance: ['ok'] })

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
