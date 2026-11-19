// 记住「这台机器上见过哪些解释器」，让一个被删掉/被搬走的运行时仍然出现在列表里，并被点名。
//
// 事由（2026-11-19 在 windows-latest 上实测）：把一个已探测到的 python.exe 挪走之后，/api/v1/runtimes 直接少一条
// （6 条 5 runnable → 5 条 4 runnable），readiness 的 python 检查仍报 passed。用户看到的是「列表少了一项」，
// 没有任何一句话说清是谁不见了、为什么。系统扫描只报「现在能找到的」，「曾经登记过但现在找不到」这件事必须有地方记着，
// 否则用户永远只能自己猜。
//
// 边界，刻意保守：
// - 只记**探测成功过**（runnable）的路径，没跑起来的本来就不该被记住；
// - 消失的条目保留 30 天，之后自动淘汰——永久的垃圾记录会让列表越长越假；
// - 只读/写一个 JSON，不碰 settings、不加 IPC 通道；文件坏了就当没有历史，绝不因此让发现流程失败。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const FILE_NAME = 'interpreter-history.json'
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_PER_LANGUAGE = 40

export type HistoryEntry = { path: string; lastSeenAt: number }
type HistoryFile = Record<string, HistoryEntry[]>

const filePath = (runtimeRoot: string): string => join(runtimeRoot, FILE_NAME)

const readAll = (runtimeRoot: string): HistoryFile => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath(runtimeRoot), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: HistoryFile = {}
    for (const [language, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue
      const kept = entries
        .filter(
          (entry): entry is HistoryEntry =>
            entry !== null &&
            typeof entry === 'object' &&
            typeof (entry as HistoryEntry).path === 'string' &&
            typeof (entry as HistoryEntry).lastSeenAt === 'number'
        )
        .slice(0, MAX_PER_LANGUAGE)
      if (kept.length > 0) out[language] = kept
    }
    return out
  } catch {
    return {}
  }
}

// Paths we have seen this language's interpreter at before, newest first. Unreadable/absent file → [].
export const readInterpreterHistory = (runtimeRoot: string, language: string): string[] => {
  const now = Date.now()
  return (readAll(runtimeRoot)[language] ?? [])
    .filter((entry) => now - entry.lastSeenAt < RETENTION_MS)
    .map((entry) => entry.path)
}

// Merges what is runnable NOW with what is still missing from before, and drops entries older than the
// retention window. `current` wins on timestamp; a path present in both is not duplicated.
export const recordInterpreterHistory = (
  runtimeRoot: string,
  language: string,
  current: string[],
  now: number = Date.now()
): void => {
  const all = readAll(runtimeRoot)
  const previous = new Map((all[language] ?? []).map((entry) => [entry.path, entry.lastSeenAt]))
  const next: HistoryEntry[] = []
  for (const path of current) next.push({ path, lastSeenAt: now })
  for (const [path, lastSeenAt] of previous) {
    if (current.includes(path)) continue
    // Keep the ORIGINAL timestamp: the retention window measures how long it has been absent, not how
    // recently we last scanned. Whether the file still exists is decided at merge time by the caller.
    if (now - lastSeenAt < RETENTION_MS) next.push({ path, lastSeenAt })
  }
  all[language] = next.slice(0, MAX_PER_LANGUAGE)
  try {
    mkdirSync(dirname(filePath(runtimeRoot)), { recursive: true })
    writeFileSync(filePath(runtimeRoot), `${JSON.stringify(all, null, 2)}\n`)
  } catch {
    // A read-only or racing directory must not take discovery down: history is an aid, not a gate.
  }
}
