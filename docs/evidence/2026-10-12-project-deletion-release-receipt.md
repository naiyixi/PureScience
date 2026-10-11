# 删项目要「说得清释放了多少」—— 回执上屏（P0-10① 未做半边收口）

> 单元：`docs/plan-2026-10-10-v2-line-schedule.md` 的 **P0-10①「删除要名副其实」** 里那条**未做半边**
> ——「把释放字节显示到界面（9 语 i18n + 渲染测试）」。
> 本体（真的删掉会话运行数据并测量）已由 `48c290f6` 交付；本单元交付的是**让这个测量被用户看见**，
> 并顺手修掉一处**会让回执说假话**的机制缺陷（见第二节第 3 条）。
>
> 本单元**没有真机窗口读数**（内存闸门，见第六节），界面那半边的证据是 **jsdom 真渲染套件**，
> 不冒充窗口读数。

---

## 一、缺陷形状（对源，逐条 file:line）

| # | 位置（本单元之前） | 错在哪 |
| --- | --- | --- |
| 1 | `src/shared/projects.ts` | 删项目的返回是 `void`：`deleteProject(id): Promise<void>` 一路贯穿 shared → 主进程 handler → preload 类型 → 渲染层 store ⇒ **测量结果（释放字节）在主进程里产生、随即被丢掉**，界面无从复述。 |
| 2 | `src/renderer/src/pages/home/HomePage.tsx`（本单元之前） | `.then(() => { … })` 只做「把项目从 store 里去掉」；对话框关闭、页面无任何回执 ⇒ 用户面对一个**信任级动作**（删掉 GB 级数据）拿不到任何数字。 |
| 3 | `src/main/projects/deletion-coordinator.ts`（本单元之前） | **失败后重试的删除，字节其实由「恢复重放」移除**：`recoverPendingDeletionsNow()` 先重放持久意图，重放走完 `finishDeletion` 时项目行**已经不在**，于是 `runDeletion` 走 `if (!project) return` ⇒ 返回「什么都没测到」⇒ 界面会把**刚刚清掉的 GB 级数据**说成「未发现存储数据」。这是**假读数**，不是文案问题。 |

## 二、交付（形状）

1. **契约**：`shared/projects.ts` 新增 `ProjectDeletionOutcome`
   （`freedBytes` / `runDataBytes` / `artifactBytes` / `uploadBytes` / `runData: 'removed' | 'absent' | 'refused' | 'not-attempted'`）；
   `projects:delete` 的返回类型从 `void` 改为该类型，主进程 handler、`data-content-application-commands.ts` 的
   `defineApplicationCommand` 签名、preload 类型声明、渲染层 `project-store.deleteProject` 逐层透传。
2. **测量点**：`provenance.deleteProjectProvenance` 与 `notebookData.deleteProjectNotebookData` 各自
   **在删除之前**测量并返回自己的切片；`finishDeletion` 求和成 `freedBytes`，四个切片保持分开
   （界面需要区分「运行数据被拒」与「产物被删」两种语义）。
3. **重试的诚实回执**：`finishDeletion` 把每次测量记进**本轮恢复表**，`recoverPendingDeletionsNow()` 开始处清表；
   `deleteProject` 在自己的结果 `runData === 'not-attempted'` 时**一次性取用**本轮重放的测量
   ⇒ 重试会报出**重放真正释放的字节**，而不是「没有存储数据」。
4. **界面回执四种，按语义而不是按数字大小选**（`HomePage.tsx`，`data-slot="home-project-deleted"`，`role="status"`）：
   - 有字节 ⇒「已删除『X』，并从本机移除了 N」（`formatBytes(bytes, lang)`，跟随界面语言）；
   - 运行数据被拒 ⇒ **优先**显示「已删除『X』，但部分运行数据未能移除」（不许读成干净成功）；
   - 未测量 ⇒ 只说「已删除『X』」，**不声称任何字节**；
   - 测到 0 ⇒「未发现它占用的存储数据」。
   回执**常驻可关**（`common.close` 为关闭按钮的 aria-label），不自动消失，便于用户按自己的节奏读。
5. **对话框文案拼装**：`DeleteProjectDialog.tsx` 里的三处硬编码英文碎片（` and its N sessions`、
   `Generated artifacts…`、拼在中文句后的 ` be undone.`）与三个硬编码按钮词（`Cancel` / `Delete` / `Deleting…` / `Close`）
   全部改走字典；`home.deleteProjectHint` 九语去掉重复的「此操作无法撤销」（英文原值本来就是被截断的 `…This action cannot`）。
6. **9 个新键 × 9 语言**（`scripts/add-i18n-keys.py` 批量插键，自带九文件齐平预检）：
   `home.deleteProjectOneSession` / `home.deleteProjectSessions` / `home.deleteProjectUnloadedSessions` /
   `home.deleteProjectManagedData` / `home.projectDeletedReleased` / `home.projectDeletedNothingStored` /
   `home.projectDeletedRunDataKept` / `home.projectDeletedNotMeasured` / `common.deleting`。

## 三、用例（本单元新增与修改）

| 文件 | 内容 |
| --- | --- |
| `src/main/projects/deletion-coordinator.test.ts` | 新增 3 条：**分片各自测量**（产物/运行数据不混成一个数）、**项目行已不在时不许说「没有」**、**重试报的是重放的测量**（第 3 条缺陷的定点守卫）；修 2 条旧断言（原来的返回类型是 `void`）。 |
| `src/main/session-persistence/deletion-integration.test.ts` | 替身改为**回传真仓库的测量结果**，不再编零值。 |
| `src/renderer/src/pages/home/HomePage.persistence.test.tsx` | 新增 4 条回执用例（释放量 + 可关闭 / 未发现存储数据 / 未测量时不做字节声明 / **被拒优先于释放量**）；替身返回真 `ProjectDeletionOutcome`。 |
| `src/renderer/src/pages/home/DeleteProjectDialog.locale.test.tsx`（新建） | jsdom 真渲染，**zh 与 en 两种语言**各断言一次，并逐条否定旧缺陷的三个形状（` be undone.` / ` and its ` / `Generated artifacts` / `This action cannot`）。 |

## 四、门禁读数（被测树 = 本单元改动，全量四环全部实跑）

| 环 | 读数 | 退出码 |
| --- | --- | --- |
| `npx eslint --no-cache .`（CI 同口径，全仓） | **0 error / 118 warning** | 0 |
| `tsc --noEmit -p tsconfig.node.json --composite false` | 无输出 | 0 |
| `tsc --noEmit -p tsconfig.web.json --composite false` | 无输出 | 0 |
| 全量 `vitest run --maxWorkers=4` | **`Test Files 1247 passed \| 16 skipped (1263)`**、**`Tests 16111 passed \| 207 skipped (16318)`**、`Duration 197.57s` | 0 |
| `bash scripts/pre-push-checks.sh`（单独跑、读退出码） | `[pre-push] 全部通过。`（README 版本横幅 v1.102.0 / CHANGELOG 条目 / 发布提醒 / 双语头部一致） | 0 |

**变异核对（守卫不是空壳）**：把 `DeleteProjectDialog.tsx` 里那行改回旧形状（在提示句后拼 ` be undone.`），
单跑 `DeleteProjectDialog.locale.test.tsx` ⇒ **当场红**：

```
Tests  1 failed | 1 passed (2)
× 中文界面没有英文碎片，且每句都来自字典
AssertionError: expected '删除项目？这将永久删除"单细胞分析"。此操作无法撤销。 它保存的 3 个对…'
  not to contain ' be undone.'
Received: "…项目工作文件夹中的文件不会被删除。 be undone.取消删除"
```

随后从备份还原，并用 `shasum -a 256` 核对**字节一致**（`before == after == bcb0254d…c929`）。

## 五、口径边界（不许读成「全绿」之外的东西）

1. **释放量只算「本次删除从项目范围内移除的字节」**：内容库的重复数据回收（另有 `nlink` 判据的回收动作）不计入。
2. **`not-attempted` 是一个真实状态**，不是「0 字节」的同义词：未接线运行数据清理器、或项目行本已不在且本轮没有重放，
   都会走到这里；界面在这种情形下**不做任何字节声明**。
3. **界面在没有窗口读数的情况下不算「实机通过」**：本单元的真机验收项（真项目删除后回执上的数字与磁盘减少量自洽）
   受内存闸门阻塞，见下节。

## 六、未取 / 阻塞（每条带 blocked-by）

| # | 未取的东西 | blocked-by | 解封条件与配方 |
| --- | --- | --- | --- |
| 1 | **真机窗口读数**：起一个真项目、真删、把回执上的数字与删除前后 `du` 的差对上 | **内存闸门**（本轮空闲物理页 7,894 ≈ 123 MB；swap 已用 4,781 / 6,144 MB；占用方含长期驻留的无关 Electron 应用 WorkBuddy） | 空闲物理页回到可用区间后：`npm run build:e2e` → 隔离开头（`--user-data-dir` + `PURESCIENCE_STORAGE_ROOT` + 独立端口三件齐）→ 建一个**唯一命名**沙盒项目并写入若干 MB 运行数据 → 走 UI 删除 → 读 `data-slot="home-project-deleted"` 上的数字与删除前后磁盘差；收尾 `projects:delete` + 删隔离根（先 `chmod -R u+w`） |
| 2 | 回执在**打包态**的样式与可读性（长项目名换行、`formatBytes` 的小数位） | 同上（需要一次打包产物） | 下一次发版后的窗口读数一并取 |

## 七、仪器缺口（单独立案，本地可核）

`scripts/i18n-hardcoded-audit.mjs` **不报** `DeleteProjectDialog.tsx`：那个文件里的硬编码英文住在
**独立成行的 JSX 文本节点 + 表达式子节点**（`{' '}` 拼接）里，扫描器的两种形状都没覆盖
⇒ 这次是靠人工读出来的，不是被仪器拦下的。修法：给扫描器补「同级 JSX 文本节点的纯英文串」一种形状，
并对本次修复前的文件版本做一次回归（应当命中）。**判据**：用它扫修好前的版本能命中、扫修好后的版本 0 命中。
