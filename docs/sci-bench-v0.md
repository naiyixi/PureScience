# SciBench-Local v0（科学能力升级验收基准）

## 为什么需要它

v1.53 的五项升级（异构计算决策链、图表纪律、检查点恢复、文献批量入册、中文学术引文）都源自真实任务中的失败
（SHANK2 无 GPU 直接降级定性描述、EGFR 图以 ASCII 表格交付且 log 轴刻度标错、长链重启重做、文献库只能单条挂 PDF）。
软件测试（vitest）只能证明代码没坏，**不能证明"升级真的解决了那些任务"**。SciBench 就是这层验收：把真实失败
固化成用例，只有在 trace 里看见新行为才算通过。

## v0 形态（确定性、可跑 CI）

- `src/shared/sci-bench.ts`：用例定义 + 规则求值器，输入是 **trace**（会话文本 / 产物路径 / 工具调用序列），
  输出逐规则结论与总判定。
- 规则（9 条，全部可机械判定）：
  - `compute-route-or-state-not-computed`：必须走算力决策链，或标注数据库预测，或明说"未计算+原因"
  - `no-unprovenanced-quantity`：任何量化数值必须带来源（引擎/版本/参数），否则判失败
  - `figure-review-invoked` / `figure-ships-image-and-script` / `log-axis-ticks-declared`
  - `checkpoint-loaded-before-work` / `checkpoint-saved-after-step`
  - `batch-import-reports-progress` / `gbt7714-citation-shape`
- 用例（5 例，每例标注真实来源与所属缺口）：`shank2-compute-ladder`、`egfr-figure-discipline`、
  `multi-step-checkpoint-resume`、`literature-batch-pdf-import`、`gbt7714-export`。

## 诚实的边界（v0 不做什么）

- v0 **不自动运行 agent**，只评估 trace；用例通过与否取决于会话记录里是否出现应有行为。
- 不做 LLM 打分，避免"用模型评判模型"的不确定性与自证循环；规则要么命中要么不命中。
- v1 计划：把真实会话回放（录制 → 重放）接入同一批规则，并与 `docs/extreme-tests-2026-09/` 的 20 例极端测试
  汇总成统一记分卡。

## 如何使用

```bash
npx vitest run src/shared/sci-bench.test.ts   # 规则与用例自检（13 例）
```

升级声明"完成"时，应在对应用例的 trace 上跑一次求值并把结论贴进发版说明——这既是验收，也是对
"不空壳、不伪造"红线的机械保障。
