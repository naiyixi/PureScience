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
- **不放宽断言**：没有把 `toBe(REFUSAL)` 改成「要么拒绝要么没拒绝」。一个两种结果都算过的断言等于没有断言。

---

## 追加（同日，第二版测量）：**上面那句「可能是产品缺陷」的判断，撤回**

第二版把「猜」换成了「测」——应用**自己就把答案摆在窗口里**：`notebook.state` 的载荷带
`environments: NotebookEnvironmentStatus[]`（`src/shared/notebook.ts:723`，由
`session-read-model.ts:198-210` 从 `kernelStatusEntries()` 映射而来，字段含 `processKey` /
`environment` / `status`）。起完内核立刻读它：

```
[v6b] environments BEFORE any run: []
[v6b] kernel start: ok=true  {"runId":"notebook-run-…","kernelKind":"python",…}
[v6b] environments AFTER the run: [{"processKey":"python:default-python",
                                    "environment":"default-python","status":"idle"}]
[v6b] entry for lock-import-env: (absent) => live=false
[v6b] removed — no live kernel was recorded, so nothing required a refusal
1 passed (1.5m)
```

**内核根本不在 `lock-import-env` 上——它在 `default-python` 上**，尽管请求里写了前者。于是把调用链逐层往上读完：

1. `kernel-executor.ts:216-223` 的进程键确实取请求里的 `environment`
   （`resolveProcessKey` ← `resolveRequestEnv`）——这条让我一度以为「表里该有那个环境」；
2. 但数据单元格的路由**不看请求**：`execution-owner.ts:192-193` 取的是
   `admission.route`，而 `data-execution-admission.ts:80-87` 的 `route()` 用
   `session.runtimeBinding(language)`，无绑定则退回默认环境；
3. 决定性的是应用**自己的 agent 工具说明**（`src/main/notebook/mcp-server.ts:53,106`）：

   > `// No 'environment': the env is the session's bound runtime (notebook_bind_runtime), not a per-call …`
   > `'There is no per-call environment. …'`

⇒ **请求里的 `environment` 不是逐次路由输入**，路由 = 会话绑定的运行时。**错的是我的配方**：
我把一个 per-call 字段当成了权威，于是「内核在 A 上执行过」这件事**从未发生过**——状态表报
`python:default-python` 是**如实的**。

**据此撤回**：上面「执行过的环境未被认作在用」这条立案所暗示的产品缺陷**不成立**；`isLive` 的行为
与状态表一致，我请求的环境压根没被选中。写在立案档 V6 行上的那句判断也一并更正。

## 正确配方（第二版已按它改，正在跑）

① 导入具名环境（同上）；② **在面板上把它选成运行时**——点具名环境行的
`named-env-use`（`RuntimesPanel.tsx:640-676`：register → enable → `runtime.setSelection`），
而 admission 会在会话无绑定时**采纳这个已保存的选择**（`runtime-service.ts:470-475` 的注释即此意）；
③ 再 `notebook.execute`（**不传** `environment`，与 UI 同形）；④ 断言「状态表里有该环境的活条目
⇒ 移除必须被逐字拒绝、目录仍在」/「无活条目 ⇒ 移除应当成功」——**断言的是两者的一致性**，
两条路径都能绿、「表说活着却放行」必红。

---

## 第三版：**读数取到了，1 passed (1.3m)**（V6 收口）

按上面的正确配方改完即通过，真机逐字读数：

```
[v6b] import: Imported “lock-import-env” — 82 packages (82 from cache, 0 downloaded).
[v6b] bound as runtime: Notebooks will use “lock-import-env”.
[v6b] environments BEFORE any run: []
[v6b] kernel start: ok=true  {"runId":"notebook-run-…","kernelKind":"python",…}
[v6b] environments AFTER the run: [{"processKey":"python:lock-import-env","environment":"lock-import-env",
                                    "kind":"python","status":"idle","restartRecommended":false}]
[v6b] entry for lock-import-env: {…} => live=true
[v6b] REFUSED as the status table required: Error: Environment "lock-import-env" is in use by a running
       kernel — restart the notebook or wait for the run to finish before removing it.
1 passed (1.3m)
```

**三点结论**：

1. **能力本体是对的**：`isLive` 认「在用」= 状态表里该环境有非 `terminated` 的条目，实测绑定后条目为
   `python:lock-import-env` / `status: "idle"`，移除被**逐字拒绝**，且环境目录仍在（那一支同时断言了
   `existsSync(envs/lock-import-env)`）——即「理由上屏」与「文件没被删」两件事都成立。
2. **这一整轮的弯路是我自己造的**：第一版把 `environment` 当权威（错），第二版才测出内核其实跑在
   默认环境上、并据此撤回「产品缺陷」的判断（见上一节），第三版走面板绑定即通过。
   **代价**：五次真机运行。**换来的**：一条可复用的配方 + 一条「per-call 字段不是路由输入」的事实。
3. **spec 现在可以落树**（它是绿的验收，不是诊断稿）：`e2e/certification/named-env-kernel-in-use.spec.ts`。
   断言写的是**契约一致性**（状态表说活着 ⇒ 必须逐字拒绝；无活条目 ⇒ 应当成功），所以它不会因为
   「哪天内核起不来了」而假装通过——那种情况会走另一支并如实报出来。

**立案档 V6 一行据此标记完成**（读数已取，配方已证）。

