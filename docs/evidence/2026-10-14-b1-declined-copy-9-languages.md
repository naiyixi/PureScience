# B1 拒绝文案 9 语：拒绝之后上屏的那句话不再只有英文

> 单元：v2.1.0（批 B）B1 的最后一条具名缺口（§九十三 就绪审计表里「B1 拒绝文案 9 语」一行）。
> 提交：`<SHA8>`（本档与代码同笔落地）。

## 一 缺口是什么，谁看得见（读源，带 file:line）

1. 应用**自有**运行路径（`request.source === 'user'`）在判定为 `review` 时向用户弹审批卡：
   `src/main/notebook/execution-owner.ts:206-226`（门在 `dataExecutionAdmission.admit` 之前，被拒的 cell 不 provision、不碰内核）。
2. 用户**拒绝** ⇒ 抛 `NotebookRunDeclinedError`，其 `message` 逐字是
   `Notebook run declined: <规则 id 列表>`（`src/main/notebook/run-risk-receipt.ts:81-85`）—— 主进程**只会拼英文**（它没有译者）。
3. 渲染端唯一的运行入口把该错误**原样上屏**：`src/renderer/src/pages/workspace/NotebookPreview.tsx`
   的 `setActionError(getErrorMessage(error))`（5 处），渲染在 `NotebookPreview.tsx:1161-1165` 的 `font-mono text-xs` 条带上；
   改动前它还带着传输信封（`Error invoking remote method 'notebook:run-cell': …`）。

⇒ **中文用户拒绝一次高风险的笔记本运行，屏上出现的是英文**（且带信封）。B1 的差异化红线里「面向中文场景解释为什么这次要拦」那一半，在卡面已经做到（`notebookRisk.*` 9 键 ×9 语），但**拒绝之后那一步没有**：这是一条真缺口，不是文档问题。

## 二 修法（三处，全部走既有路线；不新开通道、不新增机制）

| 层                       | 落点                                                   | 要点                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 信封剥除（**单一来源**） | `src/renderer/src/lib/main-message-catalog.ts`         | 新增 `unwrapIpcEnvelope`：同时认 Electron 的 `Error invoking remote method '<channel>': <Name>: <cause>` 与 Web 面的**裸** `.message`（后者见 `src/main/web-service/http-server.ts:664` 逐字发 `error.message`）。剥不掉信封 ⇒ 识别器认不出主进程那句话 ⇒ 读者永远拿到英文，这正是把它放在一处的原因 |
| 句子的重说               | `src/renderer/src/lib/notebook-risk-copy.ts`           | `notebookRunDeclinedNotice(t, message)`：认出 `Notebook run declined: <ids>`，用**卡面同一套规则名**（复用同文件的 `RULE_NAME_KEYS`）重说一遍，**机器 id 留在行内**（收据复算用的是它，与卡面口径一致）；**不认识的 id 原样保留**——拒绝不能吞掉「是哪个规则拒的」                                    |
| 呈现                     | `src/renderer/src/pages/workspace/NotebookPreview.tsx` | `getErrorMessage(t, error)`：先剥信封，再试拒绝句；**其余错误逐字透传**（与改动前一致，不重写任何主进程的拒绝）                                                                                                                                                                                      |
| 字典                     | `src/renderer/src/i18n/*.ts` ×9                        | 新键 `notebookRisk.declined`（含 `{rules}` 占位符）：zh 值 ≠ en 值、zh-Hant 全繁体、九文件齐平（脚本自证）                                                                                                                                                                                           |

## 三 读数（都是本笔实跑）

- **定向**：`notebook-risk-copy.test.ts` + `main-message-catalog.test.ts` + `src/renderer/src/i18n` ⇒ **6 文件 / 68 passed**。
- **受影响宽面**：`src/main/notebook` + `src/main/acp` + 三支 `NotebookPreview.*.render.test.tsx` + 卡面 i18n 用例 ⇒ **179 文件 / 2,887 passed｜99 skipped**。
- **变异测试 2 红（证明断言是承重的）**：
  ① 把 `{rules}` 的补位从「本地化规则名」改成裸 id ⇒ 断言「按卡面点名」的那条红（1 failed｜9 passed）；
  ② 把识别正则改成永不匹配 ⇒ **3 条红**（识别本身承重，不是摆设）。
- **双 typecheck**：`tsc --noEmit -p tsconfig.node.json --composite false` 与 `tsconfig.web.json` 均 **REAL_EXIT=0、0 条 `error TS`**。
  （诚实记录：node 环首次裸跑撞 V8 堆崩——一堆 `node::StartExecution` 栈、**没有汇总行**，按本仓既有口径抬 `--max-old-space-size=6144` 复跑才拿到判决；这正是「命令崩掉时它的输出不是判据」。）
- **`npx eslint --no-cache .`：0 error / 120 warning**（与 v2.0.0 发版门禁同一读数 ⇒ 本笔不新增 warning）。
- **`scripts/pre-push-checks.sh` EXIT=0**（五查全过，含品牌/借词扫描）。
- **全量 vitest**：同一提交 `npx vitest run --maxWorkers=4` ⇒ **1,291 passed｜16 skipped（1,307 文件）／16,559 passed｜207 skipped（16,766 条）／VITEST_EXIT=0**，311.4 s。

## 四 我**没有**取到的读数（具名，不冒充）

1. **真机（真窗口）读数未取**：需要在真窗口点一次「再次运行」→ 在卡上点拒绝 → 看那条条带的文字。
   内存闸门实测：`vm_stat` 空闲页 **5,011（×16 KB ≈ 78 MB）**、`vm.swapusage` 已用 **6,677 / 8,192 MB** ⇒ 不起 `build:e2e` + Electron。
   **这是本笔唯一缺的证据**，`blocked-by` = 内存闸门放开。
2. **Electron 信封的确切形状是按本仓既有读数推断的**（`Error invoking remote method 'acp:resume-session': RequestError: Internal error` 的形状，见
   `src/renderer/src/lib/acp/useWorkspaceAgentRuntime.test.ts:489`），本笔未在真窗口逐字观测。因此识别器**对「带类名前缀」与「不带」两种形状都成立**，两种形状 + Web 面的裸 `.message` 都有单测逐字钉住（`main-message-catalog.test.ts`）。
3. 另有 **4 份**同义的「剥信封」正则副本（`SkillsPanel.tsx:71`、`SkillUploadView.tsx:93`、`useSkillImportCandidatePreview.ts:21`、`useWorkspaceAgentRuntime.ts:251`）**未**折进本笔的单一来源（避免把无关 hunk 卷进本笔）⇒ 单独立案，等一个只做这件事的窗口。
4. `repl_execute` 一类控制面**有意不覆盖**（既有具名缺口，沿用 §八十三 的结论）。

## 五 与 v2.1.0 的关系

§九十三 的就绪审计表里，B1 的具名缺口是两条：真机读数（已由 §九十二 取到）与**本条文案**。
本笔落地后，v2.1.0 三件（B1 / B2 / B3）的**文案缺口清零**；仍具名的只剩：

- 真机（窗口）读数（内存闸门）；
- B2 的「真哈希」形态要等 v2.1.0 之后的新运行（§九十七 的真发现：本机真数据里 0 条运行带 B1 收据）。
