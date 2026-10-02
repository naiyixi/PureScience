# R2-U4 真机读数：期刊别名与用户显式合并（2026-10-03）

> 实现来源**如实标明**：代码与 e2e 断言由夜间排期执行器（cron `2be4405e5dc6`）那一轮写就，**两轮都跑到迭代上限、
> 未提交**；本会话（用户已暂停该 job）复核门禁后**跑出真机读数并提交**。读数与"成色"判断如下。

## 一、门禁（本会话复跑，不是转述）

- `npm run typecheck`：**0 error**
- `eslint`（`journal-merge.ts` / `journal-merge.test.ts` / `src/main/references/` / `src/renderer/.../references/` /
  `renderer-contract-catalog.ts` / 本 spec）：**0 error**
- 定向 vitest（`src/shared/` + `src/main/references/` + `src/renderer/src/components/references/`）：
  **130 文件 / 1476 例通过**（1 skipped）
- 入口覆盖守卫 `renderer-contract-entry-coverage.test.ts`：**5 passed**
  （片子在飞时它一度是红的——那是"新契约面还没接 UI 调用"的中间态，接上后转绿，说明守卫工作正常）

## 二、真机读数（隔离实例，真 Electron 窗口，`2 passed (7.6s)`）

命令：`npm run build:e2e && playwright test e2e/certification/journal-metrics-panel.spec.ts`

### 2.1 展示名（`displayName`）

```
[panel-reading] nature communications row: Nature Communications 2041-1723 Unknown Unknown Unknown 16.6(2023 · Journal Citation Reports) Unknown
[panel-reading] partition=一区 rows: ["Nature 0028-0836 Unknown 一区(2024 · 中科院文献情报中心) Unknown 64.8(2023 · Journal Citation Reports) Unknown"]
[panel-reading] year=2022 rows: ["Nature 0028-0836 Unknown Unknown Unknown 62.1(2022 · Journal Citation Reports) Unknown", …]
```
⇒ 面板显示**来源的原始写法**（`Nature` / `Nature Communications`），不再是规范化后的全小写。
（顺带：筛选/年份三条读数在改名后仍全部成立。）

### 2.2 显式合并（`references:merge-journals`）

```
[panel-reading] merge seed: {"imported":2,"skipped":0,"journalsCreated":2,
                             "journals":[{"normalizedName":"nature","displayName":"Nature"},
                                         {"normalizedName":"nature communications","displayName":"Nature Communications"}],
                             "aliases":0}
[panel-reading] row before merge:    Nature 0028-0836 Unknown Unknown Unknown 64.8(2023 · Journal Citation Reports) Unknown
[panel-reading] merge result:        Moved 1 metrics and 0 references; “nature communications” now resolves here.
[panel-reading] row after merge:     Naturealso known as nature communications 0028-0836 Unknown Unknown Unknown 16.6(2023 · Journal Citation Reports) Unknown
[panel-reading] alias note:          also known as nature communications
[panel-reading] library after merge: {"journals":["nature"],"aliases":["nature communications"],
                                      "aliasTarget":"cmurcqyfx0001wf06hgsf9kqs",
                                      "claims":[{"journalId":"…","value":"64.8"},{"journalId":"…","value":"16.6"}]}
```

逐条对上计划 §3 的验收口径：

| 判据 | 读数 | 结论 |
| --- | --- | --- |
| **近似名不会被自动吞并** | 合并前两行、`aliases: 0` | ✅ 正向证据（两本近似刊各占一行） |
| **显式合并生效** | `Moved 1 metrics and 0 references; … now resolves here.` + 表格两行→一行 + 库快照只剩 `["nature"]` | ✅ |
| **旧名仍能解析** | 别名行存在且指向目标刊（`aliasTarget = 目标 id`） | ✅（别名解析的单测覆盖 `by-alias`） |
| **无空壳** | 面板上有可选行 → 确认 → 具名结果文案（`merge result` 那句来自应用自己的返回） | ✅ |

## 三、本片**新发现**（我加的读数里冒出来的，未被该片覆盖，立案）

**同一 kind + 同一 year 的两条主张合并后，视图静默挑了一条。**
- 合并前：`Nature` 的影响因子是 **64.8 (2023)**；
- 合并后：同一行显示 **16.6 (2023)**（来自被并入的 `Nature Communications`），而库里两条主张**都在**
  （`claims: [64.8, 16.6]`）。
- 也就是说：屏上只剩一个数字，读者无从知道**同一年还有另一个来源/另一条值**——这与本项目"缺失显示未知、
  绝不用一个数字盖住另一个事实"的口径不符。
- **建议修法（下一片）**：同日多值时视图要么并列显示（带各自 source），要么显式标出冲突（如 `64.8 / 16.6 (2023)`），
  **不静默取一条**。本片**未做**，立案；同时记下"合并文案只报数量、不报冲突"这一点。

## 四、没取到的（具名）

- **`self-merge` / 不存在 id / 别名指向别刊** 三种具名拒绝的**真机**读数：计划 §3 要求逐条取，本轮只跑了
  上表这一条合并路径；三种拒绝目前**只有单测覆盖**（`journal-merge.test.ts` 4 例），真机未取，立案。
- **面板级"确认前"交互读数**（选择候选时的中间态）：本轮读的是合并前后的表格与结果文案，选择过程的 DOM 未取。
