# 施工单 · 筛选失败类别的具名上屏（`failureKind`）—— 2026-10-04

**状态**：侦察完成、判据三条全过、**代码未动**（下一轮照本单一次做完并验证）。

## 一、缺口（三判已过）

| 判 | 结论 | 依据 |
| --- | --- | --- |
| ① 是用户可见载荷吗 | **是** | 面板 `ReferencesScreeningPanel` 的汇总来自 main 的 `next.summary` + `next.reasonCounts`（`ReferencesScreeningPanel.tsx:311-322`），是读者正对着看的那份数据 |
| ② 语义对读者有用吗 | **是，且领域层自己写明了为什么要具名** | `src/shared/references-screening.ts:64-70`：`SCREENING_FAILURE_KINDS = ['model-error','transport-error','invalid-response']`，注释原文——「Named, so a resumed pass can **retry a transport error** and keep an unusable response **for inspection instead of retrying it forever**」⇒ 读者看到「failed: N」却分不出**该不该重跑** |
| ③ 挂载点在哪 | **面板已有同类行可照抄** | `ReferencesScreeningPanel.tsx:1039-1043` 已经在印延后理由：`SCREENING_NAMED_REASONS.filter(计数>0).map(r => `${t(REASON_LABEL[r])}: ${count}`)` ⇒ 失败类别**照同一形状加一行**即可，不新开层级 |

**现状**：`failureKind` 在 `src/renderer/src/**` **零命中**（除本条外整层没读过）——即「`failed: N` 有个数，没有类别」。

## 二、四处改动（照现成的对称形状）

### 1. shared：载荷类型加一个字段

`src/shared/references-screening.ts:255` 附近，`reasonCounts: Record<ScreeningNamedReason, number>` 旁边加：

```ts
  failureKindCounts: Record<ScreeningFailureKind, number>
```

（`ScreeningFailureKind` 已在同文件 `:71` 定义，无需新类型。）

### 2. main：同一处算出来

`src/main/references/screening-service.ts:187-214`——`reasonCounts` 现在从 **items 的 `freshness.reasons`** 计数、
在 `:214` 随载荷返回。失败类别要计的是**最近一次运行**逐条的 `failureKind`：

- 计数源是 `buildRunView(...)`（`:182-184`）那一路拿到的运行条目（`ScreeningRunItem.failureKind`，shared `:151`）；
  **动手前先确认 `buildRunView` 的返回里带不带逐条 `failureKind`**——带就直接计，不带则在它内部补（这是本单唯一需要现场确认的一处）。
- 形状照 `emptyReasonCounts()`（`:187`）：加一个 `emptyFailureKindCounts()`，遍历时 `failureKindCounts[item.failureKind] += 1`（只计有值的）。
- **不把「无失败」写成 0 之外的东西**：与 `reasonCounts` 一致，全 0 就是全 0，界面上按「只印计数 > 0 的项」处理（同 `:1040` 的 `.filter(计数>0)`）。

### 3. renderer：一行，照抄延后理由那行

`ReferencesScreeningPanel.tsx`：

```ts
const FAILURE_KIND_LABEL: Record<ScreeningFailureKind, TranslationKey> = {
  'model-error': 'references.screening.failureKind.model-error',
  'transport-error': 'references.screening.failureKind.transport-error',
  'invalid-response': 'references.screening.failureKind.invalid-response'
}
```

（放 `REASON_LABEL`（`:69-76`）旁。）渲染一行，**与 `:1039-1043` 同形**：
只印计数 > 0 的项，`标签: 计数` 用 ` · ` 连接；全 0 时该行不出现（不留空标题）。
`summaryText` 的 state 增 `failures: Record<ScreeningFailureKind, number>`，在 `:311-322` 从 `next.failureKindCounts` 赋值。

### 4. i18n：3 键 × 9 语（zh ≠ en）

键：`references.screening.failureKind.model-error` / `.transport-error` / `.invalid-response`。
命名与 `references.screening.reason.*` 同族。**语义要分清**（这决定读者是否重跑）：
`model-error` = 模型/服务出错（可重试）；`transport-error` = 传输出错（**可重试**）；
`invalid-response` = 返回不可用（**留档待查，别反复重试**）。

## 三、验证（照本仓体例）

1. **main 侧**：`screening-service` 的既有测试文件里加例——构造一次带三种 `failureKind` 的运行，
   断言 `failureKindCounts` 三项各自正确、且**不把未失败项计进来**；
2. **渲染层**：`ReferencesScreeningPanel` 的渲染测试加例——三种类别计数上屏、全 0 时该行不出现；
3. **i18n**：`translation-quality` 与覆盖率守护（新增 3 键 ×9，覆盖率仍 100%）；
4. **真机**：面板与运行都已有真机路径（`references-screening` 相关 e2e/渲染测试齐），
   **能走到「有失败」的那次运行**就取一次真窗口读数；若造不出失败运行，**就地具名立案**，不放宽断言；
5. 提交信息 + 证据档（含上面三条判的结论与真机读数）。

## 四、为什么这一轮不动手

侦察本身是完整交付（三条判据、四处改动的确切位置、i18n 键名与语义、验证清单）。
**但改动跨 shared/main/renderer/i18n 四处 + 两侧测试**，在本轮已用掉大量轮次的情况下开工，
**「做到一半被截断」的风险是实在的**——那正是本仓明令禁止的「功能半截」。
下一轮从 §二.2 的现场确认开始，一次做完并出读数。
