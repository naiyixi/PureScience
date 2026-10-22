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

## 追加采样（同日，5 次独立 run）

| arm | 次数 | `log-axis-declared` 通过 | 原子 |
|---|---|---|---|
| full-contract | 3 | **3 / 3** | 0.67（三次一致） |
| no-contract | 2 | **1 / 2** | 0.67 / 0.33 |

**先纠正一句自己的话**：上一版把单次翻转写成"提示"，重复采样后它仍是提示而不是差异——n=2 的
那一臂出现了一次通过，说明这条断言**有随机性**。要谈效应，至少 5–10 次/臂并报区间。

**另一个必须写明的口径问题**：应用没有种子控制，`seed` 只是记录里的标签，重复 run 是**独立抽样**
而不是同种子复跑。所以上表的正确说法是"3 次与 2 次独立运行"，不是"3 个种子"。

## 产物命名的未解部分

`artifact missing — observed 2: …/versions/<id>/content` 说明：API 返回的产物条目**没有 `name`**，
只有内容 blob 路径。代码已改为优先取 `name`（`84ca0cec`），但数据里没有这个字段，所以题还判不出来。
下一步要找到 "原始文件名" 落在哪里（很可能是版本记录而不是产物条目），再把它带进证据。

另：产物被写进了 `/Users/totota/PureScience-DEV/artifacts/…`——**配置目录隔离了，数据根没有**。
pilot 下次必须同时把数据根指到临时目录；本次没有删除任何文件（无法可靠区分我的产物与既有产物）。

## 产物到底在哪（磁盘核查，2026-10-22）

直接看数据目录，图题的那次 run **确实产出了带名字的产物**：

```
<dataRoot>/artifacts/<project>/<session>/<artifactId>/ic50_distribution.png
<dataRoot>/artifacts/<project>/<session>/<artifactId>/ic50_plot.py
<dataRoot>/artifacts/<project>/<session>/<artifactId>/.metadata/ic50_distribution.png.json
```

所以"artifact missing"**不是 agent 没产图，而是取证没把名字带出来**——`/api/v1/.../artifacts`
给的是 `…/versions/<id>/content`。修复方向已明确（`7a55f196`：改问文件库的 `name`），
但是否对 task 视图开放尚未验证：本轮新跑的一次（seed 3）**没有产生任何产物**，
所以那条路径仍未被真实走通。

## 方差比预想的大

同题同日 6 次 run 的原子通过率：`0.67, 0.67, 0.67, 0.33, 0.33`（另有 1 次无效）。
最新一次（seed 3）连 `log-axis-declared` 都没写、也没产图——说明这题对模型的**执行稳定性**
敏感，多于对契约敏感。因此下一阶段应先把"能不能稳定产图"当成独立问题，再谈臂效应。

## 下一步

1. 同一题跑 3 个种子（6 次 run），看 `log-axis-declared` 的翻转是否稳定；同时补 1–2 道契约覆盖题
   （`omics-preview-subset-labelled`）以降低单题偶然性。
2. 查清"图没落成产物"：是 agent 没调用产物写入，还是产物名不匹配 `(ic50|potency).*\.png` 的断言。
   这条比臂差异更值得先修——它影响每一道要图的题。
3. 成本口径不变：本轮未接 usage 记账，不报美元。
