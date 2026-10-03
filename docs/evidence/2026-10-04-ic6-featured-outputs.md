# IC6 任务产物面板（featured outputs / 留在远端 / 收割失败）— 证据与如实立案（2026-10-04）

## 缺口是什么

`JobDetailModal.tsx:225` 原样躺着一行**注释掉的占位**：

```tsx
{/* 3b placeholder: featured outputs / left-on-remote — hidden until harvest data exists */}
{/* <FeaturedOutputs job={latestJob} /> */}
```

而数据**早就在**：`JobSummary`（`src/shared/compute.ts:304-333`）已带
`featured_files` / `featured_file_count` / `left_on_remote_count` / `left_on_remote[]`（每条含
`uri` / `size_mb` / `reason`）/ `harvest_error`，`JobResult` 段（`:262-278`）还写明
**`remote_workdir` 在 `harvest_failed` 时也保留**，就是为了让文件能被人工取回。

在渲染层 grep 这三个字段的名字：**零命中**——不是「渲染得不好看」，是**一处都没读**。

## 做了什么

`src/renderer/src/components/FeaturedOutputs.tsx`（新，挂回上面那个占位处）：

| 状态 | 呈现 |
|---|---|
| 重点产出 | 文件逐条列出（workspace 相对路径），带 `featured_file_count` 计数 |
| 留在远端 | 每条**带自己的原因**（`uri · N MB · reason`）——没有原因的清单是读者无法据以行动的清单 |
| **计数大于清单** | 明说「另有 N 个未在结果里列出」，**不静默只显示子集**（那会读成「留下的只有这些」） |
| 收割失败 | `harvest_error` 原话上屏，**并把 `remote_workdir` 并排给出**——那是失败时唯一的取回路径，不能用工整的话盖掉 |
| 无收割数据 | 面板整体不出现（不留空标题） |

## 验证

```
npx vitest run FeaturedOutputs.render.test.tsx JobDetailModal.render.test.tsx
Test Files  2 passed (2)
     Tests  14 passed (14)      ← 我的 4 条 + 模态框原有 10 条（挂载无回归）
translation-quality          42 passed（5 键 × 9 语，zh ≠ en）
typecheck:web                exit 0        eslint  0 problems
npm run build:e2e            ✓ built     真机冒烟：IC9 spec 1 passed (12.3s)
```

渲染测试直接建在**真实的 `JobSummary` 形状**上（字段名与 `shared/compute.ts` 逐字对齐），
四种状态各自的断言见 `FeaturedOutputs.render.test.tsx`。

## 立案：真机「已收割」读数本机取不到（**不假装取到了**）

要让弹窗里出现这个面板，必须有一个**真的作业**；而应用只有一种 provider 约定——`ssh:<alias>`
（`src/shared/compute.ts:91`）。本机没有可用的远程主机，`compute:*` 的 e2e 目录里也因此
**一条 spec 都没有**。所以：

- **已取到**：面板的四种状态在真实 `JobSummary` 形状上的渲染（jsdom）；挂载后模态框用例无回归；
  构建后应用照常起、既有真机 spec 照常过。
- **未取到**：真窗口里一个**真的收割过**的作业上，这些字段的实际上屏。
- **补法（下一轮，需环境）**：接一台可用的 SSH 主机 → 交一个作业 → 造一次失败收割（例如让远端
  产物超过大小上限）→ 在真窗口取三样读数：重点产出计数、留在远端条目含原因、失败收割的
  `harvest_error` 与 `remote_workdir` 同时在场。

按本仓口径，这一条**立案**而不是记账为已完成；面板本身不是空壳（它读的是真实载荷类型里的字段），
但「实机跑通」这四个字这一轮只兑到上面「已取到」那几行。
