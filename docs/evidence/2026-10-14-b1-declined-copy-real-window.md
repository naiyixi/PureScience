# B1（v2.1.0）被拒运行的文案：真窗口读数 + 认证 spec 进仓（2026-10-14）

## 一 本单元要证的判据

运行被用户拒绝之后，**屏上留下的那句话**必须是卡面同一套规则名的中文/英文说法，
且**不再出现**引擎的类名与传输信封：

- 改前上屏：`Error invoking remote method 'notebook:execute': NotebookRunDeclinedError: Notebook run declined: fs-delete`
- 改后应上屏：`Notebook run declined: deletes files (fs-delete) — no code was executed.`

改动的三处（已在 `99b85ddd` 落地）：`main-message-catalog.ts` 的 `unwrapIpcEnvelope`、
`notebook-risk-copy.ts` 的 `notebookRunDeclinedNotice`（机器 id 留行内）、
`NotebookPreview.tsx` 的 `getErrorMessage` 在 `setActionError` 的 5 个落点统一走它。

本单元补的是这条改动**缺的那一条**：真窗口读数与其认证 spec。

## 二 为什么这句必须用真窗口量，以及真窗口在哪一层被挡住

这句话只在一个地方合成：`NotebookPreview.tsx` 的 `getErrorMessage`（`:86-90`），
渲染在 `data-testid="kernel-terminal"` 的条带里（`:1169-1171`）。而在它之前那一步，**唯一**能让这条
error 出现的入口是面板**自己的**运行控件（终端 + Enter），该控件被
`notebookGated()` 关着（`provisioning-view.ts:74-83`：`!status.pythonReady` ⇒ 灰掉）。

而 `status` 有**两种来源**，这是本单元踩到的关键机制：

| 场景 | `notebook-env:getStatus()` 的来源 | pythonReady 怎么来 |
| --- | --- | --- |
| 装好的应用（`resources/micromamba` 在） | `createNotebookEnvironmentLifecycle` 的真实生命周期 | **读盘**：`pythonReady(root, DEFAULT_ENV_VERSION)`（`runtime-paths.ts:491`：就绪标记 + 解释器文件在） |
| 没有 provisioner（开发构建、或打包件缺 micromamba 资源） | `createUnavailableLifecycle.status()`（`environment-lifecycle-workflows.ts:66-70`） | **写死 `false`**，盘上有什么都不看 |

⇒ 第二条路上**任何播种都打不开面板**（我第一版 spec 正是这样红的：`expect(status.pythonReady).toBe(true)` 收到 `false`），
它只能被**具名挂起**，不能改断言、也不能把「打不开」记成「文案没出现」。

## 三 本单元的做法（spec 进仓）

`e2e/certification/notebook-declined-copy.spec.ts`（P0 集合：`npm run test:e2e:p0` = `playwright test e2e/certification`）：

1. 向应用自己问出数据根（`api.storage.getInfo()`），在**它自己的隔离根**里写两样东西：就绪标记
   （`runtime/.env-ready`，`defaultEnvVersion: 1`）与一个**占位解释器文件**（`runtime/envs/default-python/bin/python`）。
   这是门闸的全部条件（`pythonReady` 只查这两样），且**什么都不执行**：运行在卡面就被拒，从不启动内核 ——
   这条由 spec 末尾的运行记录断言单独说（只断言本格脚本 `rmtree` 没有记录，因为本 spec 借用的
   溯源夹具自己会留一条运行）。
2. 重启应用（`configureFakeAgent()`）让它读盘，**先读出状态并断言前提**，再动终端。
3. 真窗口四步：终端键入 `shutil.rmtree('probe-dir')` → Enter → 卡面出现并点名
   （`deletes files` / `fs-delete`）→ 点卡面自己的 `deny-button` → 读条带。
4. 条带断言**两向**：含 `Notebook run declined` / `deletes files (fs-delete)` / `no code was executed`；
   **不含** `NotebookRunDeclinedError` 与 `Error invoking remote method`（后两条是本次改动的要害）。

没有 provisioner 时（上表第二行）走**具名挂起**分支，把应用自报的整份状态打进挂起原因里 ——
「这条车道够不到那句话」与「那句话不在」被分开命名，且车道不会因此变红。
两支判据不靠猜：**只有 provisioner 支的状态带 `pythonRecoveryBlocked` / `rRecoveryBlocked` 两个字段**（实测两种形状各一次）。

## 四 读数（本机，逐字）

`PURESCIENCE_MICROMAMBA_BIN=<本机用户态 conda 安装里的 micromamba> npx playwright test e2e/certification/notebook-declined-copy.spec.ts`

```
[b1-declined] the app reports: {"pythonReady":true,"rReady":false,"version":1,"provisioning":false,
  "bundleSource":{"kind":"official","baseUrl":"https://github.com/naiyixi/PureScience/releases/download/runtime-v1"},
  "pythonRecoveryBlocked":false,"rRecoveryBlocked":false}
[b1-declined] the strip says: "Notebook run declined: deletes files (fs-delete) — no code was executed.\n>>>"
  1 passed (8.8s)
```

无 provisioner 支（不带那个环境变量，同一条 spec）：

```
[b1-declined] the app reports: {"pythonReady":false,"rReady":false,"version":1,"provisioning":false,
  "bundleSource":{"kind":"official","baseUrl":"..."}}
  1 skipped                      # 挂起原因里带着上面这份状态
```

**本地跑这条 spec 的前置（具名）**：本机的开发/未打包构建要靠 `PURESCIENCE_MICROMAMBA_BIN`
指到一个真的 micromamba（本机在用户主目录下的一个本地 conda 安装里），否则落到「没有 provisioner」那一支。
打包件不需要它：`electron-builder.yml` 的 mac 段把 `resources/bin/mac/${arch}/micromamba` 复制到
`Contents/Resources/micromamba`，`resolveMicromamba()`（`micromamba.ts:32-60`）的第二个候选就是它。

## 五 本单元**没做**的（具名，别读成已做）

1. **认证车道是否真的执行了严格支**：只能由那次 Nightly 的 `Build macos-arm64` 作业日志判 —— 判据是日志里出现
   `[b1-declined] the strip says:` 那一行（执行了）或 `1 skipped`（该 app 不带 micromamba）。
   按下之前不许写「车道已证」。
2. **中文（9 语）在真窗口的逐字读数**：本机 e2e 面是英文；九语由 i18n 质量门与渲染用例覆盖，
   真窗口只读了英文那一版。
3. **被拒之后不留运行记录**这一条，本 spec 只断言了「本格脚本没有记录」；完整的「拒绝 ⇒ 零记录」
   由 `e2e/certification/notebook-run-risk-approval.spec.ts`（`source: 'user'` 的桥接路径）断言，两条互补不重复。

## 六 顺带修掉的一处车道红（同日）

Nightly 的 `Build macos-arm64 → Enforce platform certification` 红在 `session-fork.spec.ts:27` 的
`Error: nothing to press`（`boundingBox()` 为 null）：那是**一次重挂载**被当成产品失败，且它当场
作废了该 spec 自己的三次重试设计。修法见 `bac0081e`（有界等框 + 卡片不在屏上就重开 + 无框只当作
一次「没按上」交回重试循环），**断言一字未改**。
