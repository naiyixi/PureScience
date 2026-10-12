// D3（v2.0.0 结构工作台）：**结构观察**（选择 / 测量）的会话日志。
//
// 与 `connectors/reading-journal.ts` 同一套形状与理由（照抄不是偷懒，是让两条证据链长得一样，
// 读的人不必学第二套规则）：
//  - 一次会话一个 JSON 文件，主进程独占写入（临时文件 + rename），**录制永不把异常抛回调用路径**
//    （录制失败只会在读的时候表现为 `not-recorded`，不会让一个已经成功的回合失败）；
//  - **有界**：保留最新 N 条，丢掉多少**如实回报**（`dropped`），不静默；
//  - 归属是**会话 + 时间**，并且**写在值上**（读侧据此判断窗口），不假装知道"是哪一次运行产生的"。
//
// 为什么要有这个载体：指纹本身不是证据 —— 选择在发出那一回合之后就被忘掉了，
// 「这个产物是在哪次选择/测量下产出的」就没有可查的答案。这里就是那个答案的落点。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { StructureMeasurement } from '../../shared/structure-measurement'
import type { StructureSelection } from '../../shared/structure-selection'

export const STRUCTURE_OBSERVATIONS_DIR = '.structure-observations'

/** 每个会话保留的最新条数；更旧的丢掉并计数。 */
export const MAX_SESSION_OBSERVATIONS = 200

export type StructureObservationEntry = {
  /** 录制时刻（ISO 8601）—— 读侧用它做时间窗判断，所以必须是可解析的戳。 */
  recordedAt: string
  kind: 'selection' | 'measurement'
  /** 二者按 kind 只有一个存在（判别联合在这里用可选字段表达，便于直接 JSON 往返）。 */
  selection?: StructureSelection
  measurement?: StructureMeasurement
}

export type StructureObservationJournal =
  | { state: 'available'; entries: StructureObservationEntry[]; dropped: number }
  | { state: 'unavailable'; reason: 'not-recorded' | 'unreadable' }

const journalPath = (storageRoot: string, sessionId: string): string =>
  join(storageRoot, STRUCTURE_OBSERVATIONS_DIR, `${sessionId}.json`)

/** 读一次会话的观察记录。**缺文件 = not-recorded**（"没录过"与"录坏了"分开命名）。 */
export const readSessionStructureObservations = async (
  storageRoot: string,
  sessionId: string
): Promise<StructureObservationJournal> => {
  try {
    const raw = await readFile(journalPath(storageRoot, sessionId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { state: 'unavailable', reason: 'unreadable' }
    const record = parsed as { entries?: unknown; dropped?: unknown }
    const entries = Array.isArray(record.entries) ? record.entries.filter(isObservationEntry) : []
    const dropped = typeof record.dropped === 'number' ? record.dropped : 0
    return { state: 'available', entries, dropped }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    return code === 'ENOENT'
      ? { state: 'unavailable', reason: 'not-recorded' }
      : { state: 'unavailable', reason: 'unreadable' }
  }
}

const isObservationEntry = (value: unknown): value is StructureObservationEntry => {
  if (!value || typeof value !== 'object') return false
  const entry = value as { recordedAt?: unknown; kind?: unknown }
  return (
    typeof entry.recordedAt === 'string' &&
    (entry.kind === 'selection' || entry.kind === 'measurement')
  )
}

// 同一会话的写串行化：并行回合是常态，朴素的"读-改-写"会让除最后一条以外的全部丢失
// （而 `dropped` 还报 0）。reading-journal 为同一个理由做了同一件事。
const writeChains = new Map<string, Promise<void>>()

/**
 * 追加一条观察。**永不抛**：失败只是这一次没记录下来（读侧会看到 not-recorded / 条数对不上）。
 */
export const recordStructureObservation = async (
  storageRoot: string,
  sessionId: string,
  entry: Omit<StructureObservationEntry, 'recordedAt'> & { recordedAt?: string }
): Promise<void> => {
  const path = journalPath(storageRoot, sessionId)
  const previous = writeChains.get(path) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await mkdir(join(storageRoot, STRUCTURE_OBSERVATIONS_DIR), { recursive: true })
        const existing = await readSessionStructureObservations(storageRoot, sessionId)
        const entries =
          existing.state === 'available' ? existing.entries : ([] as StructureObservationEntry[])
        const droppedBase = existing.state === 'available' ? existing.dropped : 0

        const recorded: StructureObservationEntry = {
          recordedAt: entry.recordedAt ?? new Date().toISOString(),
          kind: entry.kind,
          ...(entry.selection ? { selection: entry.selection } : {}),
          ...(entry.measurement ? { measurement: entry.measurement } : {})
        }
        const all = [...entries, recorded]
        const overflow = Math.max(0, all.length - MAX_SESSION_OBSERVATIONS)
        const kept = overflow > 0 ? all.slice(overflow) : all

        const temporary = `${path}.tmp`
        await writeFile(
          temporary,
          `${JSON.stringify({ entries: kept, dropped: droppedBase + overflow }, null, 2)}\n`,
          'utf8'
        )
        await rename(temporary, path)
      } catch {
        // 录制是尽力而为：这里吞掉，绝不让一次成功的回合因为日志写失败而失败。
      }
    })
  writeChains.set(path, next)
  await next
}
