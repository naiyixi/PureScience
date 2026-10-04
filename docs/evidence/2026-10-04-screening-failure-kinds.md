# 筛选失败类别的具名上屏（`failureKind`）—— 证据（2026-10-04）

## 缺口与三判

| 判 | 结论 | 依据 |
| --- | --- | --- |
| ① 用户可见载荷 | 是 | 面板的运行块读 `next.lastRun`（`ReferencesScreeningPanel.tsx:337-350`），读者正对着它 |
| ② 语义对读者有用 | 是，且**领域层自己写明了理由** | `src/shared/references-screening.ts:64-70`：三种类别具名，注释原文「a resumed pass can **retry a transport error** and keep an unusable response **for inspection instead of retrying it forever**」 |
| ③ 挂载点 | 现成 | 运行块已在印 `assessed/deferred/failed/pending`（`:1268-1274`），**照同一形状加一条**即可 |

**改动前**：`failureKind` 在 `src/renderer/src/**` **零命中** ⇒ 读者只看到 `failed: N`，**分不出该不该重跑**。

## 四处改动（对称形状）

1. **shared** `ScreeningRunView` 加 `failureKinds: Record<ScreeningFailureKind, number>`，注释写明「与 `failed` 并列，因为类别决定下一步」；
2. **main** `screening-service.ts` 的 `buildRunView` 里照 state 计数同一处，按条目的 `failureKind` 计数（`SCREENING_FAILURE_KINDS` 初始化三项，只计有值的）；
3. **renderer** `FAILURE_KIND_LABEL`（放 `REASON_LABEL` 旁，同族键名）+ 运行块里**仅在 `failed > 0` 时**出现的一条细分（只印计数 > 0 的类别，`标签: 计数` 以 ` · ` 连接；`data-testid="screening-run-failure-kinds"`）；
4. **i18n** 3 键 × 9 语（`references.screening.failureKind.*`，zh ≠ en；语义按「可重试 / 留档待查」分清）。

## 读数

| 层 | 命令 | 结果 |
| --- | --- | --- |
| main 计数（**新增**） | `vitest run screening-service.test.ts` | **16 passed** —— 新用例用一个**真会抛 `ScreeningTransportError` 的 runner** 跑完一次真运行，读出 `failed: 2, failureKinds: {model-error: 0, transport-error: 2, invalid-response: 0}` |
| 渲染（**新增**） | `vitest run ReferencesScreeningPanel.render.test.tsx` | **21 passed** —— 新用例两支：`failed: 0` ⇒ 该行**不出现**；`failed: 2`（两种类别各 1）⇒ 两个名字都在、**未发生的类别不出现** |
| zh 词表 | 同上（真实字典断言） | 三键拼出「模型出错 / 传输错误 / 返回不可用」，不是机器 token |
| i18n 守护 | `translation-quality.test.ts` | **42 passed** |
| 类型 | `typecheck:web` / `typecheck:node` | **0 / 0**（新必填字段未波及其他夹具） |
| lint | `eslint`（5 个改动文件） | 0 problems |

## 未取（具名）

**真窗口里一次「有失败」的筛选运行**：需要隔离实例里配好可用的模型提供方（`runnerAvailable` 为真），
本轮未配 ⇒ **未取**。补法（一条 spec 即够）：在隔离实例里让模型返回一次传输错误 → 打开筛选面板 →
读运行块那行（断言三种类别里只有发生的那一类出现、且与 `failed` 数一致）。**没把断言放宽成
「有就断言、没有就跳过」**——那等于没断言；这一条挂在立案里。

## 顺带

- 施工单里原定把字段挂在**集合级载荷**（`reasonCounts` 旁）；读代码后改为挂在**运行视图**——
  故障属于某一次运行，而 `ScreeningRunView` 已经有 `failed`、面板也已在印它。语义与位置都更对，
  已在施工单与提交信息里说明这次偏离。
- 同一个普查里的 `deferredReason` **经查已有汇总面**（`:1040-1042` 按 `REASON_LABEL` 印 `理由: 计数`），
  已从缺口清单划掉——「以为没人读」和「真的没人读」之间隔的就是那一次 grep。
