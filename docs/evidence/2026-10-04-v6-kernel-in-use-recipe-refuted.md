# V6「在用内核时拒绝移除」— 五次真机运行的结论：**配方的前提不成立**（2026-10-04）

## 结论先说

`e2e/certification/named-env-kernel-in-use.spec.ts` 一路跑到**最后一步**才暴露出问题，而且暴露的是一个
**否定结果**：内核确实在那条具名环境上起来了，**但移除没有被拒绝**——环境被真的删掉了。

面板自己给出了铁证（失败截图 2，逐字）：

```
Removed 'lock-import-env'.
```

这是 `RuntimesPanel.tsx:633` 的**成功**提示（`runtimes.namedEnvRemoved`）。**拒绝一次都没发生**
⇒ 面板点「移除」的那一刻，`environment-management.ts:159-166` 的 `isLive('lock-import-env')` 返回 **false**。

## 前提是什么、为什么它不成立

立案档（`docs/plan-2026-10-03-v1.81.0-queue.md` §V6）里我写下的推导是：

> `window.api.notebook.execute` 的请求是 `NotebookSessionRequest & { code, language?, environment? }`，
> **`environment` 就是「在哪条具名环境里执行」** ⇒ 直传 `lock-import-env` 就能让 `isLive` 为真，不必绕界面。

**这句推理的后半段是错的。** 真机读数：

| 步骤 | 读数 |
|---|---|
| 导入（复用 `lock-import.spec.ts` 的锁 + 缓存） | `Imported "lock-import-env" — 82 packages (82 from cache, 0 downloaded).` |
| 造真会话 | `sessions=1 id=e2e-session-1 cwd=…/PureScience-DEV/workspaces/<uuid>` |
| **直传 environment 起内核** | **`ok=true`**，返回真 `runId=notebook-run-…`、`cellId=…`、`kernelKind=python` |
| 打开设置 → 具名环境行可见 | ✅ |
| 点移除 → 确认 | **成功**：`Removed "lock-import-env".`，**无 error，无拒绝** |

⇒ 「在这个环境上执行过代码」**不等于**「这个环境被 `isLive` 认作在用」。两者之间还有一环没走通。

## 两种可能成因（下轮一次跑就能分辨）

1. **内核在跑完后被回收**：`isLive` 只看**当时**的 `kernelStatusEntries()`，而一次性
   `execute` 起的内核可能在回合结束/空闲后被关停 ⇒ 到点移除时它已不是「running」。
2. **键名对不上**：`isLive` 判的是 `processKey.slice(indexOf(':')+1) === name`，即进程键 `:` 之后那段
   必须**恰好等于环境名**。若实际键带的是解释器路径或别的后缀，那么无论内核活多久都不会命中。

**分辨配方**（下轮直接执行）：`execute` 之后立刻读
`window.api.notebook.state({ sessionId, workspaceCwd })` 并把 `kernelStatusEntries` 逐条打印——
- 有条目且 `status !== 'terminated'` 但**后缀 ≠ `lock-import-env`** ⇒ 成因 2（键名），这是**产品缺陷**，
  该修的是键名而不是测试；
- 条目已 `terminated`/不存在 ⇒ 成因 1，取证要**让内核在移除那一刻仍活着**（走界面把该环境绑成会话
  运行时再跑一格，而不是一次性 `execute`）。

## 已走通、可直接复用的那部分（别重造）

spec 里这四段在真机上**全部验证通过**，下轮照用：

1. 导入链 + `Cancel` 关模态（`Escape` **关不掉**这个弹窗——这是我第一版踩的坑）；
2. 从 `sessions.loadAll()` 取 `{id, cwd}`——**`workspaceCwd` 就是 `session.cwd`**
   （`WorkspacePage.tsx:1680` 等处把 `activeSession.cwd` 当 `workspaceCwd` 传）；
3. `notebook.execute` 直传 `environment` **确实能起真内核**（`ok=true`，带真 runId）；
4. **工作区里没有「Model settings」那个按钮**——首页才有；工作区要靠应用自己的快捷键 ⌘, / Ctrl+,
   （`App.tsx:170-193`），而且**必须先等页面画出来再用**（瞬时 `count()` 会读到 0，而快捷键在
   `isSessionPersistenceHydrated` 为假时被守卫吞掉——这是我第二、三版踩的坑）。

## 处置

- **spec 不提交**：它按现在的配方**跑不绿**，而按本仓口径，跑不绿的用例不许当验收落进树里。
  近乎完整的版本留在 `~/.hermes/cache/scratch/comp/v6-named-env-kernel-in-use.spec.ts`，
  下轮改一处（加 `notebook.state` 诊断）即可继续。
- **V6 仍立案**，但立案内容比原来**更精确**：不是「起不了内核」（内核起得来），而是
  「**执行过的环境未被认作在用**」——这本身就是个可能的产品缺陷（见成因 2），值得下轮优先分辨。
- **不放宽断言**：没有把 `toBe(REFUSAL)` 改成「要么拒绝要么没拒绝」。一个两种结果都算过的断言
  等于没有断言。
