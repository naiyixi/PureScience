# Pilot report · figure-axis-discipline · 2026-10-22

第一对**契约覆盖**的对照实验（上一对自己写下了"这题没有契约，臂无从生效"，这一对换了题）。

## 环境

| 项 | 值 |
|---|---|
| 应用 | 构建产物 `out/`（v2.15.3 + 本轮改动），config root `/tmp/ps-pilot-b`（实验后删除） |
| runtime | `opencode` |
| 模型 | `deepseek-v4-flash` |
| 种子 | 1 |
| 权限档 | `full` |
| 题 | `figure-axis-discipline`（origin: v0 `egfr-figure-discipline`；背后是 `figure-style` 技能，**有契约**） |
| 臂校验 | A：48 技能 / **19 带 contract**，`os-figure-style` 有契约；B：48 技能 / **0 带 contract** |

## 结果

| 臂 | Pass@1 | 原子通过率 | ic50-figure-with-script | log-axis-declared | no-useless-empty-figure |
|---|---|---|---|---|---|
| full-contract | ✗ | **0.67** | ✗ artifact missing | ✅ | ✅ |
| no-contract | ✗ | **0.33** | ✗ artifact missing | ❌ pattern missing | ✅ |

记录：`2026-10-22T04-32-59-297Z-figure-axis-discipline-full-contract.json`、
`2026-10-22T04-40-56-311Z-figure-axis-discipline-no-contract.json`。

## 读法（先说限度）

1. **这是提示，不是结论**：n=1、单种子、单 runtime、单模型。要谈效应至少 3 个种子 × 多题。
2. 唯一翻转的断言是 `log-axis-declared`：契约可见时 agent 明确写了对数轴/log scale，
   契约不可见时没有。这与 `figure-style` 契约里"对数轴刻度自检"的要求方向一致。
3. **两臂都没产图**（`ic50-figure-with-script` 都失败，原因是 artifact missing）——
   这是独立于臂的产品信号：agent 在 notebook 里出图，但没有落成带 `.png`+生成脚本的产物。
   评分器按设计把这种情况判为失败，而不是接受"口头上画了"。

## 下一步

1. 同一题跑 3 个种子（6 次 run），看 `log-axis-declared` 的翻转是否稳定；同时补 1–2 道契约覆盖题
   （`omics-preview-subset-labelled`）以降低单题偶然性。
2. 查清"图没落成产物"：是 agent 没调用产物写入，还是产物名不匹配 `(ic50|potency).*\.png` 的断言。
   这条比臂差异更值得先修——它影响每一道要图的题。
3. 成本口径不变：本轮未接 usage 记账，不报美元。
