# 技能目录：一个「永远不可能命中」的缓存

**读数是这么来的**：`compose runtime steps` 里 `specialist-skill-catalog` 历史上出现过 1,160 ms，之后是
505 / 324 / 374 ms。它做的事只有一个：`settingsService.listSpecialistSkillCatalog()` → `catalog()` →
`SkillRegistry.list()` + `UserSkill.list()`。所以先量 `SkillRegistry.list()` 本身。

## 发现

`bundledSkillCompatibility(sourceDir)` 的缓存是**单个槽**：

```ts
let compatibilityCache: { signature: string; value: string } | undefined   // 一个槽
```

而它的键是**每个技能目录**。49 个技能 = 49 个不同的键抢 1 个槽：每次 `list()` 都要为每个目录重走一遍
目录树（`stat` 281 个文件）**并读全文算 sha256**（2.1 MB），缓存不可能命中。

## 读数（`resources/skills`：49 个技能 / 2.1 MB / 281 文件）

| | 第一遍 p50 | 第二遍 p50 |
|---|---|---|
| 改前 | 203.4 ms | **260.2 ms**（第二遍更慢 —— 缓存已死的证据） |
| 改后 | **46.0 ms** | **29.3 ms**（第二遍终于便宜） |

复现：`PURESCIENCE_BENCH_SKILL_CATALOG=1 npx vitest run scripts/bench/skill-catalog.bench.test.ts`
（读到 `docs/bench-runs/2026-10-25-skill-catalog.txt`）

## 改法

1. `Map<sourceDir, {signature, value}>`：命中判据不变（还是 `size:mtime` 签名），只是不再互相顶掉；
2. `list()` 里 49 个技能原本是**顺序** for-await，每个都走自己的目录 → 改 `Promise.all`。每个条目只读
   自己的 `SKILL.md` 与自己的目录，彼此独立；`map` 保序，失败仍按条目跳过并记 warn。

## 真机（打包版，同一台机器）

`compose step slow` 是阈值行（>250 ms 才打）。改前两次启动都打出来了：

| 启动 | `specialist-skill-catalog` |
|---|---|
| 2.18.0（改前） | 324 ms、374 ms（历史上还有 1,160 ms） |
| 改后 runId `2efe78f0` | 未触发阈值行（< 250 ms） |
| 改后 runId `8cd93762` | 未触发阈值行（< 250 ms） |

同一批启动里 `open-project-db` 为 125 / 127 ms（快路径稳定命中，不再出现 330 ms）。

**注意**：这两次启动的 `compose runtime steps` 合计是 302 / 388 ms，慢的不是它——`load-probe-answers`
跑到 107 / 189 ms 成了新的最慢项。本文件只声明「技能目录这一项掉到阈值以下」，不声明启动总时长。
