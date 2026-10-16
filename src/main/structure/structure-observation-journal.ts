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

import { createHash } from 'node:crypto'

import { createLogger, errorLogFields } from '../logger'
import {
  FIGURE_DERIVATION_FINGERPRINT_PREFIX,
  figureDerivationRecipe,
  isFigureDerivationObservation,
  type FigureDerivationInput,
  type FigureDerivationObservation
} from '../../shared/figure-observation'

import type { StructureMeasurement } from '../../shared/structure-measurement'
import type { StructureSelection } from '../../shared/structure-selection'
import type { StructureSelectionLabel } from '../../shared/structure-selection-label'

export const STRUCTURE_OBSERVATIONS_DIR = '.structure-observations'

/** 每个会话保留的最新条数；更旧的丢掉并计数。 */
export const MAX_SESSION_OBSERVATIONS = 200

export type StructureObservationEntry = {
  /** 录制时刻（ISO 8601）—— 读侧用它做时间窗判断，所以必须是可解析的戳。 */
  recordedAt: string
  /**
   * `figure-derivation`（U4）：**插图派生结果**（按类别分派出来的一类，以及这一类允许派生的那一件），
   * 与它由什么产出（输入指纹 / 模型 revision）。三种 kind 走同一条载体：一次会话一个文件、同一套
   * 有界与串行化规矩 —— 不给插图另起一套账。
   */
  kind: 'selection' | 'measurement' | 'figure-derivation'
  /** 二者按 kind 只有一个存在（判别联合在这里用可选字段表达，便于直接 JSON 往返）。 */
  selection?: StructureSelection
  measurement?: StructureMeasurement
  /**
   * D4：用户给这一段起的名字/上的色（**规范化后的**，录制点已经当作不信输入过一遍）。
   * 它随观察一起落盘，所以「这个产物是在哪次命名下产出的」在证据链里是可查的 —— 名字是人对区域的
   * 称呼，不进指纹（指纹只回答「这是哪一段」）。
   */
  label?: StructureSelectionLabel
  /** 只有 `kind: 'figure-derivation'` 有（形状与守卫见 `shared/figure-observation`）。 */
  figureDerivation?: FigureDerivationObservation
}

/**
 * 输入指纹：**先算配方那一行**，再算规范串的 sha256（与 reading-fingerprint 同一套做法）。配方是 shared
 * 里的公开常量，所以任何拿到这条记录的人都能在应用之外复算它。
 */
export const figureDerivationFingerprint = (input: FigureDerivationInput): string =>
  `${FIGURE_DERIVATION_FINGERPRINT_PREFIX}${createHash('sha256')
    .update(figureDerivationRecipe(input))
    .digest('hex')}`

/**
 * 把一次会话的观察记录裁进「版本写出之前」这个窗口 —— **纯函数**，所以在没有库、没有产物的前提下
 * 也能把时间窗的语义钉死（本仓不认"看起来对"的窗口）。
 *
 * 三种缺态分开计数，绝不互相冒充：
 *  - `afterWindow`：**有**可解析的时间戳，且在版本写出之后（写在值上，不是"不予显示"）；
 *  - `undated`：时间戳无法解析（更早的写入方可能没写戳）⇒ 不能声称它属于窗口内，也不能说它晚于版本；
 *  - `windowKnown`：版本自己有没有可解析的写出时刻。**没有 ⇒ 窗口没法强制**，调用方必须把这件事
 *    写在值上（attribution 换成会话级），而不是假装窗生效了。
 */
export type StructureObservationWindow = {
  items: StructureObservationEntry[]
  afterWindow: number
  undated: number
  windowKnown: boolean
}

export const projectStructureObservationWindow = (
  entries: StructureObservationEntry[],
  writtenAtIso: string | undefined
): StructureObservationWindow => {
  const writtenAt = writtenAtIso === undefined ? Number.NaN : Date.parse(writtenAtIso)
  const windowKnown = Number.isFinite(writtenAt)

  const items: StructureObservationEntry[] = []
  let afterWindow = 0
  let undated = 0
  for (const entry of entries) {
    const recordedAt = Date.parse(entry.recordedAt)
    if (!Number.isFinite(recordedAt)) {
      undated += 1
      continue
    }
    if (windowKnown && recordedAt > writtenAt) {
      afterWindow += 1
      continue
    }
    items.push(entry)
  }
  return { items, afterWindow, undated, windowKnown }
}

export type StructureObservationJournal =
  | { state: 'available'; entries: StructureObservationEntry[]; dropped: number }
  | { state: 'unavailable'; reason: 'not-recorded' | 'unreadable' }

const log = createLogger('structure-observations')

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
  const entry = value as { recordedAt?: unknown; kind?: unknown; figureDerivation?: unknown }
  if (typeof entry.recordedAt !== 'string') return false
  if (entry.kind === 'selection' || entry.kind === 'measurement') return true
  // 派生那一条必须**形状完整**才算一条：一个 kind 写着 `figure-derivation` 而内容读不出来的行，比没有
  // 这一行更糟 —— 它会以空白形态出现在证据链里，读的人以为「派生过、只是没内容」。
  return entry.kind === 'figure-derivation' && isFigureDerivationObservation(entry.figureDerivation)
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
          ...(entry.measurement ? { measurement: entry.measurement } : {}),
          ...(entry.label ? { label: entry.label } : {}),
          ...(entry.figureDerivation ? { figureDerivation: entry.figureDerivation } : {})
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
        // 记一行「真的落盘了」：盘上有文件是给读侧看的，这行是给排查的人看的（两者要能对上）。
        log.info('structure observation recorded', {
          sessionId,
          kind: recorded.kind,
          entries: kept.length,
          dropped: droppedBase + overflow
        })
      } catch (error) {
        // 录制是尽力而为：这里吞掉，绝不让一次成功的回合因为日志写失败而失败 —— 但**不静默**，
        // 否则「没录过」与「录了没成功」在日志里同形。
        log.warn('structure observation recording failed; the turn is unaffected', {
          sessionId,
          ...errorLogFields(error)
        })
      }
    })
  writeChains.set(path, next)
  await next
}
