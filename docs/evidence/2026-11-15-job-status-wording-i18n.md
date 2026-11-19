# 远端作业的状态词：四个界面各自写了英文，中文界面里读到的就是英文

日期：2026-11-15（执行器轮次 §三百三十七）

## 一 症状

把界面语言切到中文，一场跑过远端作业的会话里会出现这样的读法：

```
biowulf  Run EDA analysis  — finished        ← 会话时间线里的作业卡
[ DONE ]                                      ← 作业详情弹窗右上角的徽章
biowulf  Run EDA analysis   queued · 12s      ← 提交后还在跑的那一行
```

这些词旁边的一切都已经翻了（`产物文件`、`留在远端主机上的 N 个`、`收集失败`），只有状态词是英文。
所以这不是"某些文案还没翻"的普遍现象，而是**同一个概念被四处各写了一遍**。

## 二 根因

判据是"这个词从哪来"，不是"这一句读起来像不像没翻"：

| 位置                                    | 原写法                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `components/JobStatusBadge.tsx`         | `STATUS_STYLE: Record<ComputeJobStatus, { label: string; className: string }>`，`label: 'Queued' / 'Done' / 'Timeout' …` |
| `components/CompletedJobCard.tsx`       | `switch (job.status)` 返回 `{ label: 'finished' \| 'failed' \| 'timed out' \| 'error' }`                                 |
| `components/RemoteJobRow.tsx`           | `{job.status === 'submitted' ? 'queued' : 'running'} · {elapsedStr}`                                                     |
| `pages/workspace/ConversationPanel.tsx` | 附件上传芯片：`transfer.status === 'queued' ? 'Queued'`                                                                  |

四个组件、四份手写枚举。第三个尤其说明问题：同一行里 `elapsedStr` 是本地化的、状态词不是。
两处（徽章与卡片）连"已取消"这一态都没有——它不是失败，但也没有词，只能落到 `default: job.status`。

**为什么审计器没报**：`node scripts/i18n-hardcoded-audit.mjs src/renderer/src/components/CompletedJobCard.tsx
src/renderer/src/components/JobStatusBadge.tsx` 改动前输出 `TOTAL heuristic hits: 0`。它的形状是
`aria-label=`/`>text<`/返回单引号句子/整行短标签……，而这里是**对象字面量的 `label:` 属性**与
**三元表达式里的一串英文**，两种都不在它的覆盖面里（见 §五 的处置）。

## 三 改动

| 位置                                                | 改动                                                                                                                                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/job-status-label.ts`（新）              | 唯一口径：`JOB_STATUS_I18N_KEYS: Record<ComputeJobStatus, TranslationKey>` + `jobStatusLabel(status, t)`。用 `Record<联合>` 而不是 switch，新增一个状态时**编译期**就会要求补词；联合外的历史值原样显示（`t(undefined)` 会在渲染里抛） |
| `components/JobStatusBadge.tsx`                     | 只剩配色表；词取自上面那支                                                                                                                                                                                                             |
| `components/CompletedJobCard.tsx`                   | 同上；`default: job.status` 那支随之消失（未知值由模块兜住）                                                                                                                                                                           |
| `components/RemoteJobRow.tsx`                       | 运行/排队那一行改用同一支                                                                                                                                                                                                              |
| `pages/workspace/ConversationPanel.tsx`             | 上传芯片 `'Queued'` → `t('common.queued')`                                                                                                                                                                                             |
| 九语字典                                            | 新增 8 键：`jobStatus.{queued,running,success,failed,timeout,error,cancelled}` + `common.queued`                                                                                                                                       |
| `components/job-status-label.render.test.tsx`（新） | 21 条：逐状态两语对值、卡片两种终态、闭集覆盖、以及"组件里不许再出现英文状态字面量"的静态守卫                                                                                                                                          |

`submitted` 与 `queued` **共用一句**（"调度器收下了，还没开始跑"）：给它们两句话等于造一个读者
无法据此行动的区别。

## 四 读数

**1. 逐状态的两语读数**（真 `LanguageProvider` + `localStorage` 语言偏好，不是替身字典）：

```
✓ the badge says the Chinese word for queued / submitted / running / success / failed / timeout / error / cancelled
✓ the badge still says the English word for …（8 条，防止把英文也翻了）
✓ the conversation card names the status in the interface language
✓ a cancelled job is named as such, not as a failure
✓ every status in the closed list resolves to a key both dictionaries hold
✓ reads every component that names a status（3 个文件都读到，且各自 >500 字节）
✓ holds none of the English status words as a string literal
Tests  21 passed (21)
```

**2. 守卫的变异自证**（守卫若不会失败，就等于没守）：往 `JobStatusBadge.tsx` 插一行
`const __mutationProbe = 'Done'` 后，同一支用例当场红：

```
FAIL > no component spells the status itself > holds none of the English status words as a string literal
Test Files  1 failed (1)   Tests  1 failed | 20 skipped (21)
```

随后从备份还原，`grep -c __mutationProbe` = **0**。

**3. 旧断言按新契约更新，未放宽**：`job-observation-ui.test.tsx` 里原先钉着 `'finished' / 'Timeout' / 'queued'`
这些**旧英文字面量**。改成引用字典值（`en['jobStatus.timeout']` 等），并补上原先缺的 `cancelled`
两处（徽章表 + 卡片表）。这样文案再改一次不用改两处，而"每个状态都说出自己的词"这条本意不变。

**4. 门禁**

| 环                                                 | 读数                                                                                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全量 vitest `--maxWorkers=4`                       | **1480 files passed / 31 skipped（1511）**；**18556 passed / 228 skipped（18784）**；**exit 0**（上一轮基线 1479/18533 ⇒ +1 文件 +23 例：新文件 21 + 旧文件补的 2 条 `cancelled`） |
| `src/renderer/src/components` 全目录               | 68 files / 560 passed                                                                                                                                                              |
| `src/renderer/src/i18n`（九语门禁 + 质量门）       | 5 files / 73 passed（含新文件）                                                                                                                                                    |
| 双 typecheck（`--composite false`）                | node **0** / web **0**                                                                                                                                                             |
| `npx eslint --no-cache`（本笔全部改动 + 九语字典） | 0 error / 0 warning                                                                                                                                                                |

## 五 审计器的这一格：量过了，但**没有**加形状

把这次漏掉的形状写成正则试量了一遍（`(label|title|caption|text|hint|tooltip|ariaLabel): '首字母大写…'`，
按 `scripts/i18n-hardcoded-audit.mjs` 同一套排除规则）：

```
files=1327 hits=208
```

208 条里混着两类完全不同的东西：一类是真的漏翻（就是本笔修的那几个），另一类是**契约允许的
"规范英文 + 渲染时翻译"**（消息中心的 `label: 'Task completed'` / `'Task failed'`，主进程落库、
渲染层映射——那是 `src/shared/notifications.ts` 头注释写明的约定）。正则分不开这两类，
加进去就是 208 条的洪水。按该审计器自己的纪律（"某个形状一片洪水说明这个形状要收紧，不是待办清单"），
**本轮不加**，改为具名立案：下一轮的仪器类候选是"**只认语义**的状态词形状（值必须等于某个
`*Status` 联合的成员名或它的显示词，而不是任意大写词）"。

## 六 边界（不许读成更强）

- 本笔只覆盖**远端作业**这一族状态词。`ReviewerCard`、`ReferencesScreeningPanel` 等其它族的
  status→文案不在本次取证范围内，未核。
- 没有真机窗口读数：本笔改的是渲染层文案与一支纯映射模块，没有新的可点击路径或新数据；
  取证用的是真 `LanguageProvider` 下的渲染读数 + 全量门禁。**装机版要等下一次发版**才会带着它。
- 审计器的形状缺口仍在（§五），因此"全仓已无硬编码文案"这句话本轮**依然不能说**。
