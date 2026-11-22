# `references-page-selection` 的偶发红：读数、定因候选与修法（2026-11-22）

> 这一篇只记录**从真机车道读出来的东西**，以及一个尚未在 Windows 车道上验证过的修法方向。
> 本轮没有改任何产品代码，也没有改那支 spec —— 修法需要一条 Windows 车道的判决才能算数。

## 1 读数来源（可复查）

- 车道：`Release` run **44918012666**（HEAD `7eeed30d56d7c08a4e778a43d788fa269ce68e57`），
  作业 **136893439936**（`build / Build windows-x64`）里的 `Run P0 Electron certification`。
- 作业汇总行：**`2 failed / 1 flaky / 121 passed (45.3m)`**；其中 flaky 的正是本 spec。
- 首跑（16:12:11Z 开始）失败，**retry #1 通过**（16:12:54 → 16:13:15Z），因此计为 flaky 而不是 failed。

首跑失败的逐字日志（`gh api repos/naiyixi/PureScience/actions/jobs/136893439936/logs`，第 2241–2270 行）：

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('checkbox', { name: 'table-evidence.pdf' })
Expected: visible
Timeout: 20000ms
Error: element(s) not found
  - waiting for getByRole('checkbox', { name: 'table-evidence.pdf' })
> 29 |   await expect(page.getByRole('checkbox', { name: 'table-evidence.pdf' })).toBeVisible()
```

## 2 失败当刻的界面（ARIA 快照，不是猜）

失败时上传的 `p0-test-results-windows-x64` 里有该用例的 `error-context.md`，其中对话框一节写着：

```
- dialog "Reference library":
  ...
  - paragraph: Import from project PDFs (selected 0)
  - paragraph: No PDF files in this project.
```

⇒ **不是「渲染慢」、也不是「被盖住」**：对话框已经渲染完，列表已经走完加载并报了**空态**。
一个已经报空态的列表不会因为再等 10 秒而长出那一行 —— 20 秒超时只是把这个空态读成了超时。

## 3 那条列表的数据从哪来（读源，不是推断）

- 界面：`src/renderer/src/components/references/ReferencesLibraryDialog.tsx:775-792` 的加载函数调
  `window.api.projectFiles.listFiles({ projectId, collection: { kind: 'all' }, limit })`，
  过滤 `.pdf` 后 `setPdfCandidates(...)`；空数组时上屏 `references.pdfImport.empty`（`en.ts:630`
  = `No PDF files in this project.`）。
- 主进程：`listFiles` 走 `src/main/project-files/query-owner.ts`，读的是 **`ManagedFile` 表的投影**
  （同一文件 `:213-230` 的 `ProjectFileKinds` 查询直接 `SELECT … FROM "ManagedFile"`）。
- 投影的写入方是 `src/main/project-files/mutation-owner.ts`（`managedFile.upsert`，`:474`）——
  也就是说**文件落盘之后还要等一次投影/扫描**，`listFiles` 才看得见它。

## 4 定因候选（两条，判据都在上文的读数里）

| # | 候选 | 支持它的读数 | 反证/边界 |
| --- | --- | --- | --- |
| ① | **投影滞后**：夹具的 `sendPrompt` 等的是假 agent 的回复文本（prompt 级），而 picker 打开时 `ManagedFile` 投影还没收进那个 PDF ⇒ 读到空态；Windows 负载下滞后 >20 s，retry 时已收进 | 空态逐字在屏；retry 通过；链路是「投影 → listFiles」 | 本机未复现（macOS 上同 spec 稳定通过），所以「滞后多少秒」没有本机读数 |
| ② | picker 打开后**不会自刷新**：即使投影一秒后收进，已打开的对话框仍停在空态 | 加载只在打开时发生一次（`:791` 的加载函数由 `openPdfPicker` 触发），没有订阅投影变更 | 同上：未在本机造出「打开后投影才更新」的时序 |

两条可以同时成立，合起来的形状就是：**spec 断言的时机绑在了「agent 说完了」，而它真正依赖的是「投影里有这一行」**；
一旦后者比前者慢过默认 20 s 超时，红灯与产品行为无关。

## 5 修法方向（尚未验证，不许当已修）

1. **spec 侧（首选，收紧而非放宽）**：在 `openPdfPicker` 之前，用应用自己的桥轮询
   `projectFiles.listFiles({collection:{kind:'all'}})` 直到 `table-evidence.pdf` 出现（有界轮询 + 明确的
   失败原因「投影在 N 秒内没有收进这个 PDF」），**再**打开 picker 做原来的 UI 断言。
   这样红灯的含义从「20 秒内没出现」变成「投影没收进」——两者是不同的事。
2. **产品侧（另一条，需单独立项）**：让投影暴露「扫描/变更在飞」的状态，picker 据此显示加载态而不是空态；
   或让已打开的 picker 订阅投影变更。这条要动主进程与界面两面，连锁大于 ①。
3. **不做**：把 20 s 改成 60 s。空态是**已经答完的问题**，加时间只是把同样的错误藏得更久。

## 6 验收判据

- 修法 ① 的判据：同一提交在 **Windows 车道**上跑该 spec，连续两趟都不出现 flaky（首跑即通过或
  「首跑失败原因是投影未收进」且 retry 通过都算**未修好**）；本机 macOS 同 spec 仍需通过。
- 本轮未做任何修改：spec 与产品代码保持 `7eeed30d` 时的样子。

## 7 修法 ① 已落地（2026-11-22 09:1x，执行器）—— 读数与变异自证

改的是**等待的对象**，不是等待的长度：打开 picker 之前先用应用自己的桥轮询投影，直到那件 PDF 在
`collection:{kind:'all'}` 的列表里出现（同一个 collection、同一条 `.pdf` 过滤、同样 100/页的翻页上限，
与 `ReferencesLibraryDialog.tsx:770-792` 的加载函数逐条对齐）。失败信息自己具名：
`the project-file index never took the fixture PDF, so the picker had nothing to list`。

隔离工作树 `/tmp/ps-gate-rps`（`HEAD` = `e322acf3` + 这一处改动，node_modules 软链到主仓）：

| 环 | 读数 |
| --- | --- |
| `tsc --noEmit -p tsconfig.node.json --composite false`（`NODE_OPTIONS=--max-old-space-size=8192`） | **EXIT=0**（`e2e/**/*` 在该 project 的 include 里） |
| `eslint --no-cache e2e/certification/references-page-selection.spec.ts` | **0 error / 0 warning** |
| `npm run build:e2e` | `✓ built in`，三份产物（main/preload/renderer） |
| 该 spec（macOS 真窗口，`npx playwright test <该文件>`） | **1 passed（20.7 s）** |

**变异自证（这道守卫不是空转）**：把轮询谓词改成永假（只认 `absent-fixture.pdf`），同一命令得到
**1 failed**，失败行逐字是上面那句具名信息 —— 也就是说「投影没收进」这一半真的会被读到，
而不是被 20 秒的断言预算盖住。

主树跑 `npm run typecheck:node` 时 EXIT=2，两条 `TS6133` 落在 `src/main/settings/provider-env.test.ts`
（会话在制、`M` 状态）⇒ 与本批无关；隔离工作树同命令 EXIT=0 即归属证据。

**仍未取证的一格**：Windows 车道的判决（判据见 §6）。这条 spec 只在 `build.yml` 的
`Run P0 Electron certification` 里执行，`Nightly` / `Windows Full Test` 都不跑认证 spec ⇒ 只能靠一次
按需派发的 `Release`（`release_tag` 留空，只出产物）拿读数；本轮推送后立即派发，读数补在
`docs/plan-2026-10-03-next-queue-and-round-convention.md` §一百九十九 §三。
