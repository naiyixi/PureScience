# 语料里的长窗：今天的判据会叫什么（mirror 读数，2026-11-17）

> 本档回答 §三百四十八 §五① 留下的那一格：**「2.27.0 语料里 66 条 >10 分钟的窗口归到 `process-frozen`」**。
> 结论分两半，且两半不可互换：**记录下来的 sampler 读数**足以回答「今天的规则会怎么判」（141 条，其中 66 条长窗全数命中）；
> **没有任何一次运行真的写下了 `process-frozen`**（2.27.0 期的语料里最长的停顿只有 8.15 s）。

## 一 本单元交付

`scripts/log-corpus-attribution.mjs` 现在多一行 `frozen mirror`：它把生产者
（`src/main/diagnostics/stall-cause.ts`，`FROZEN_GAP_SHARE = 0.8`）那道门**重算一遍**，用的输入是**行上已经记录**的
sampler 读数（`host.status === 'sampled'` 时的 `host.maxGapMs`）。

三件事写死在实现里：

1. **mirror 与判词分列**。上面那行 `stalls:` 数的是「写出这一行的那个版本说了什么」；`frozen mirror` 数的是「今天的代码会说什么」。
   两者并进一列，就等于把重算冒充成读数。
2. **读数缺席是 `undecidable`，不是 `not frozen`**。`host` 不在场或 `status` 不是 `sampled` 的行单独计数（本例 0 行）——
   「没测到」与「测到了没冻」是两回事。
3. **判据只有一个来源**。重算用的是生产者的常量，脚本里那份副本由 `--selftest` 去读 `src/main/diagnostics/stall-cause.ts`
   逐字比对；两边漂开即失败（已用变异证明：把副本改成 0.9 ⇒ `selftest FAILED: mirror gate 0.9 disagrees with … (0.8)`，退出 4；
   改回 0.8 ⇒ 退出 0）。没有那份源文件的场景（脚本被拷出仓库跑）会打印一行具名 note，不静默跳过。

## 二 读数（真实安装版语料 `~/Library/Logs/PureScience/main.log`，8,150 行）

```
stalls: 1179 late 71,461,865 ms — unmeasured 1061 | cpu-in-process 58 | unexplained 57 | garbage-collection 3
frozen mirror: 141 of 1179 row(s) carry a sampler gap today's gate calls process-frozen (69,225,738 ms late)
               — 0 already say so, 141 disagree: unmeasured 70 | unexplained 57 | cpu-in-process 13 | garbage-collection 1
```

| 窗口宽度 | 重算判为 frozen | 当时写下的判词                                                                      |
| -------- | --------------- | ----------------------------------------------------------------------------------- |
| > 10 min | **66**          | unmeasured 34 ｜ unexplained 32                                                     |
| 1–10 min | 26              | unmeasured 14 ｜ unexplained 12                                                     |
| 10–60 s  | 13              | unmeasured 5 ｜ unexplained 6 ｜ **cpu-in-process 2**                               |
| ≤ 10 s   | 36              | unmeasured 17 ｜ unexplained 7 ｜ **cpu-in-process 11** ｜ **garbage-collection 1** |

- **66 条长窗 100% 命中**：sampler 的洞覆盖窗口的比例，最小 1.00、中位 1.001、最大 6.44 倍（`maxGapMs` 可以比被测窗口更宽，
  因为它是**最宽的一段**，不是「刚好这段」）。这与生产者头注里「2.26.0 语料 120/659 条洞覆盖 ≥80%」是同一种形状。
- **反向也不是全中**：非 mirror 的行里最长的一条晚到 **129,438 ms**（>2 分钟）却**没有**被判 frozen —— 说明这道门不是
  「长就算冻」，它要的是 sampler 自己也没跑。
- **14 条判词是错的**：13 条写着 `cpu-in-process`、1 条写着 `garbage-collection`，而那一窗本进程根本没有线程在跑。
  这正是把 GC/CPU 判在 frozen 之前的后果，也是 2.27.0 把 frozen 提到最前面的理由。

## 三 边界与具名未办（不许读成更强）

1. **mirror 不是判决**。语料里 `0 already say so` —— **2.27.0 上线后没有任何一次真机运行写下 `process-frozen`**：
   该版本期的 72 条停顿最长只有 8,149 ms，远够不到能让这道门出场的量级。§三百四十八 §五① 的口径承诺因此
   **在「今天的规则会怎么判」这一半成立、在「真机真写过一次」这一半仍为空**。
2. **要补上那一半，只有两条路**（都留作下一单元，不并在本笔）：① 等真实语料自己出现一条长窗；
   ② 在**隔离根**起一个实例，对它做一次可控的整进程冻结（`SIGSTOP` 约 70 s 后 `SIGCONT`），读出它自己写下的判词。
   本机现况（free ≈ 62 MB、load 4.2）不适合为这件事再起一次构建；本条按「未取证」记，不当作已办。
3. **语料来自 2.26.0 与 2.27.0 两段**：`process-frozen` 判词 11-14 才进主干，所以旧段的行天然不会有它。
   本档的所有「今天的规则会说」都建立在**行上确实记了 `host.maxGapMs`** 之上；读数缺席的行不可判（本例 0 行）。

## 四 门禁（全部实跑）

| 环                                                         | 读数                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `node --check scripts/log-corpus-attribution.mjs`          | 通过                                                                                                                 |
| `node scripts/log-corpus-attribution.mjs --selftest`       | `selftest OK（含 frozen-gate mirror + shared constant）`，退出 0                                                     |
| 变异证明（副本 0.8 → 0.9）                                 | `selftest FAILED: mirror gate 0.9 disagrees with src/main/diagnostics/stall-cause.ts (0.8)`，退出 4；改回 0.8 退出 0 |
| `npx eslint --no-cache scripts/log-corpus-attribution.mjs` | 见计划档本节                                                                                                         |
| `npx prettier --check scripts/log-corpus-attribution.mjs`  | 见计划档本节                                                                                                         |
| `bash scripts/pre-push-checks.sh`                          | 见计划档本节（推送时实跑）                                                                                           |
