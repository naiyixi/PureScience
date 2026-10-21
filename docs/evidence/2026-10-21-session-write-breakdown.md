# 会话保存的 `writeMs` 到底花在哪：先量，再决定要不要做增量写（2026-10-21）

> 一句话结论：**在空闲机器上，整份重写一个 1 MB 级会话只花 4–10 ms（序列化 1–6 ms + 落盘 2–4 ms + 替换 0.1 ms）**，
> 而真机慢保存的 `writeMs` 中位是 98 ms。差 10–25 倍 ⇒ 「整份重写的字节成本」不是字段读数的主因。
> 所以本轮**没有**去做「消息级增量追加」这个候选，而是把 `writeMs` 切成五段让它自己说清楚 —— 判据从「再猜一次」变成「下一次真机日志」。

## 一 这条读数是为什么取的

`docs/evidence/2026-10-17-p0-4-slow-save-phases.md` 把 159 条慢保存的 142.7 s 切成六段：`writeMs` 44.6 s（31%）、
`authorityMs` 39.9 s（28%）、`aftermathMs` 37.0 s（26%）、`prepareMs` 8.7 s、`queuedMs` 12.5 s（只有 3 条 > 500 ms）。
该档据此定的下一单元是「消息级增量写」，验收判据是「`writeMs` 中位与 p90 落进基线一半以内」。

**但那一步的前提没被量过**：44.6 s 是「我们自己的序列化 + 落盘 + 替换」里的哪一段？如果主要是文件系统，
按字节做增量写能省的只是字节数；如果主要是 `JSON.stringify`，那才是改文档形状能拿掉的成本。
按「先有仪器再优化」的常态口径，先量一次再动结构。

## 二 量法（只读，副本落在 `/tmp`，一个字节都不写真实数据根）

取本机真实数据根 `~/.purescience-project/sessions/*/*.json` 里**中位**与**最大**两份会话，复制到临时目录后计时：

```js
// 与 repository.atomicWrite 同一形状：JSON.stringify(payload, null, 2) + '\n'
pretty  = time(() => JSON.stringify(parsed, null, 2) + '\n')
compact = time(() => JSON.stringify(parsed) + '\n')
diskPretty  = time(() => fs.writeFileSync(target, pretty, 'utf8'))
diskCompact = time(() => fs.writeFileSync(target, compact, 'utf8'))
rename = time(() => fs.renameSync(target, target + '.renamed'))
```

## 三 读数（n = 2 份真实会话 + 中位那份 5 次重复）

| 文件 | 源字节 | 消息数 | pretty 字节 | compact 字节 | stringify pretty | stringify compact | 落盘 pretty | 落盘 compact | rename |
|---|---|---|---|---|---|---|---|---|---|
| 中位 | 868,111 | 32 | 868,111 | 748,035 | **1.4 ms** | 1.0 ms | **1.74 ms** | 0.83 ms | 0.11 ms |
| 最大 | 3,117,545 | 97 | 3,117,545 | 2,774,539 | **6.33 ms** | 4.80 ms | **3.98 ms** | 3.06 ms | 0.13 ms |

5 次重复（中位那份）：`stringify pretty` 1.01/0.98/0.99/0.97/0.96 ms；`stringify compact` 0.75/0.72/0.75/0.70/0.73 ms；
`JSON.parse`（读取路径）0.92/0.91/0.91/0.92/0.89 ms。

**三条能直接说的事**：

1. **一次 3.1 MB 会话的整份重写 ≈ 10.4 ms**（6.33 + 3.98 + 0.13）。空转的保存与真机 98 ms 中位差一个数量级。
2. **改成紧凑 JSON 只省 14–25% 字节、0.4–1.5 ms** —— 它不是那个缺失的杠杆（且会牺牲会话文件的可读差异）。
3. **读取路径同样便宜**：解析 868 KB 用 0.91 ms，而真机 `authorityMs` 中位 105 ms ⇒ 读写两侧都是「代码很便宜、机器很贵」的形状。

**由此推出的边界（不许读成更强）**：真机 98 ms 中位不是这份探针能解释的，也不是它能反驳的 —— 探针跑的是**同一台机器的空闲时刻**、
用的是**未打包的 Node**、写的是 `/tmp`。它与字段读数的差异**指向机器侧**（内存压力下的写回/抖动，本机当时
`swap used 13.5 G / 14.4 G`、空闲页 ≈ 111 MB），但**这一句是推断，不是读数**。判它的入口是下一节那个分段。

## 四 本轮交付：把 `writeMs` 切成五段（而不是重写文档）

| 段 | 量的是什么 | 在哪量 |
|---|---|---|
| `writeQueueMs` | 在仓库自己的保存队列里等前一次写 | `saveSession` 入队前取戳 |
| `writeMaterializeMs` | 裁剪/脱敏/路径编码 —— 产出字节之前的 CPU | `writeSessionToDirectory` |
| `writeSerializeMs` | `JSON.stringify` 整份文档 | `atomicWrite` |
| `writeDiskMs` | 建目录 + 写临时文件 | `writeSessionToDirectory` + `atomicWrite` |
| `writeReplaceMs` | 让写可见的那次 rename（含重试等待） | `atomicWrite` |
| `writeUnaccountedMs` | 五段没解释掉的余量（**打印出来，不摊进任何一段**） | 慢保存日志 |

- 形状：`SessionRepository.saveSession(session, onWritePhases?)` —— 用**回调**而不是返回值，是为了让既有那些
  「一个参数」的替身仍然满足这个面（少了它会一次性改一堆夹具），也让不需要读数的调用方不付分配。
- **只在字节真的落定之后才报**：写失败的保存没有可归因的分段（有专门一条用例钉住「失败时一条都不报」）。
- `writeMs` 保留旧含义（`writtenAt - preparedAt`），新旧读数仍可比；五段只作它的切分，`writeUnaccountedMs` 让
  「切分没覆盖全部」这件事本身可见。

## 五 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| 定向 vitest（`repository.test.ts` + `coordinator.test.ts`） | **2 files / 152 passed**，exit 0 |
| 模块簇 `src/main/session-persistence` | **13 files / 240 passed**，exit 0 |
| 双 typecheck（`--composite false`，堆 8192） | node **0 error**；web **0 error** |
| `eslint --no-cache`（本笔 4 文件） | **0 problem** |

**新增/加强的断言**（只加强，未放宽）：
① `reports where a session write spent its time` —— 五段都是非负整数，且其和**不超过测试自己测到的整次保存耗时**（覆盖性，不是精确值）；
② `reports no breakdown for a write that never became durable` —— rename 永久失败时**一条都不报**；
③ `carries the write breakdown into the slow-save line, with the remainder printed` —— 五个字段原样进慢保存行，
且余量不为负；
④ 三处既有断言 `saveSession).toHaveBeenCalledWith(...)` 追加了 `expect.any(Function)`（**加强**：现在也钉住「报告器被传进去」）。

## 六 边界与具名未办

1. **本单元没有降低任何耗时**：它是一个读数，不是优化。`writeMs` 的绝对值这条改动一个字节都没动。
2. **字段读数要等一次带本代码的运行**：`blocked-by` = 用户打包版跑的下一个版本（或一次带本代码的真机回合）。
   解封后第一件事：取一条 `session save was slow`，看 `writeSerializeMs` 是否随字节规模增长 ——
   是 ⇒ 增量写有账算；不是（序列化只占个位数 ms 而 `writeDiskMs` 吃掉大头）⇒ **不要**做增量写，改去查写回压力。
3. **探针不是产品路径的等价物**：未打包 Node、`/tmp` 目标、空闲时刻；它只回答「代码这一侧的字节成本有多大」。
4. **没有碰发版四文件**；v2.15.3 仍是 Latest。
