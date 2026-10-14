# 已部署插件的目录与卸载 —— v2.3.0「明确没做」② 的收口

- 日期：2026-10-15
- 归属：排期自主执行器（自拟单元；会话同期在 `src/main/specialist/plugin-deploy.ts` / `plugin-run-policy.ts` 那条「部署与运行策略」线上，本单元只碰 `plugin-catalog.ts` 这一个新模块与它自己的接线面，另一处唯一的交集是把记录文件名提为单一来源）
- 落点：`origin/main` 上紧随 `f0dca20f` 的那一笔（代码 + 本档 + 队列档 §一百三十七 同一笔）；推送后本地 main 与 `origin/main` 同点

## 一 为什么做这一件（缺口原话）

v2.3.0 的 CHANGELOG 在文末「明确没做（逐条具名）」里写着：

> **插件目录的展示与管理**：部署后的插件在盘上 ✓，但**没有**「已部署插件」列表/卸载/更新界面 ⇒ 同名再部署会被 `already-deployed` 拒，读者无法在应用内替换

也就是说「部署」当时是一扇**单向门**：文件真在盘上、`deployed.json` 真写了进去，而应用里**没有任何地方**能看见它、或删掉它。用户被卡在「只能进不能出」的半截功能里 —— 这正是交付红线里「禁功能半截」那一条。

## 二 交付形状（层 → 文件 → 做什么）

| 层 | 文件 | 做什么 |
| --- | --- | --- |
| 主进程服务 | `src/main/specialist/plugin-catalog.ts`（新） | `listDeployedPlugins` / `removeDeployedPlugin`。行按**应用自己的 `deployed.json`** 报逐条 `bytes` + `sha256`，另加**实测** `onDiskBytes`；`record-missing` / `record-unreadable` **各自具名**（不静默跳过）；删除前先核 id 形态与记录，四个具名拒绝（`unsafe-plugin-id` / `confirmation-missing` / `not-a-deployed-plugin` / `removal-failed`），**先量后删**并回 `freedBytes`，`absent` 与「释放 0 字节」分开 |
| 记录名单一来源 | `src/main/specialist/plugin-deploy.ts` | 写侧与读侧共用 `DEPLOYED_RECORD_FILENAME`（否则「能部署」与「能卸载」会因为两个字面量漂移而失效） |
| 共享契约 | `src/shared/plugin-source.ts`、`src/shared/specialist.ts` | 目录请求/结果类型（`action: 'list' \| 'remove'`，沿用既有「一条通道两动作」体例）+ 通道常量 `SPECIALIST_IPC.PLUGIN_CATALOG`；`PLUGIN_ID_PATTERN` 提为单一来源（schema 与删除路径共用一个判据） |
| 通道四处齐 | `renderer-contract-catalog.ts`（ELECTRON 档）、`preload/index.ts`、`preload/renderer-api.d.ts`、`specialist/ipc.ts` | 目录项 + 按公开路径的包装 + 类型化表面 + 主进程处理器（只需 plugins 根即可注册，与预览/部署解耦） |
| 渲染层 | `stores/specialist-store.ts`、`pages/settings/SpecialistsPanel.tsx` | 「Deployed plugins」区块：逐行给 id / 文件数 / 磁盘字节 / 部署时间 / 逐条 `sha256` 前缀；**Remove 只在 `state === 'deployed'` 的行渲染**（对 `record-missing` 行闸门必拒 ⇒ 不做死控件）；确认勾选是 `confirmed` 的**唯一来源**，一次确认只授权一次移除；移除后**重读列表**并报释放字节；部署成功后同样重读（部署 → 上屏 → 移除 → 消失的闭环） |
| i18n | 9 个字典各 +13 键 | 用本技能自带 `scripts/add-i18n-keys.py`（九文件齐平预检 + 写后自证）；`es` 有一条被判「与英文同形」（`bytes` = bytes）⇒ **改文案**（`resumen sha256`）而不是放宽白名单 |
| 测试 | `plugin-catalog.test.ts`（新，13 条）、`SpecialistsPanel.render.test.tsx`（+4 条） | 真部署（调用产品自己的 `deployPlugin`）后读盘；摘要与体积由**测试自己**复算（`createHash` + 自写目录遍历）；路径逃逸用例证明 `../not-touched` **从未进入 path join** |

**不做死控件的那条判据**：`record-missing` / `record-unreadable` 的行**照实上屏**（静默跳过会被读成「什么都没有」），但**不渲染** Remove —— 因为闸门对它必拒，一个只能被拒的控件不是入口。

## 三 读数（本机真实运行）

| 门 | 读数 |
| --- | --- |
| 新模块 `plugin-catalog.test.ts` | **13 passed**（6 条列表 + 7 条移除） |
| `SpecialistsPanel.render.test.tsx` + `src/main/specialist` | **19 文件 / 342 passed** |
| 更宽受影响簇（`src/main/specialist`、`src/shared`、`src/preload`、`src/renderer/web`、`src/renderer/src/{stores,pages/settings,i18n}` + 两个 composition 套件，`--maxWorkers=2`） | **250 文件 / 3098 passed（1 skipped）**，EXIT=0 |
| 契约 pin 级联 | catalog 481→**482**；表面清单 481→**482**（含 `GENERATED_SOURCE_OMISSIONS` 加一员）；preload 可调用清单加一员 + runtime 契约 242→**243**；本地 Web `unavailable` 82→**83**；specialist 面 35→**36**；`npm run gen:web-api-map` 输出**逐字节未变**（⇒ 档位确为 ELECTRON，没动任何 Web 面） |
| 双 typecheck | `typecheck:node` / `typecheck:web` **各 0 error**（带 `--max-old-space-size=8192`） |
| 全量 `vitest --maxWorkers=4` | **1315 文件（1299 passed ｜ 16 skipped）、16874 条（16667 passed ｜ 207 skipped）**，EXIT=0 |
| 全仓 `eslint --no-cache .` | **0 error / 128 warning**（本笔碰过的路径 **0 条**；剩下的 warning 全是仓内既有 prettier 漂移，其中 5 条来自本笔新测试文件、已用限定文件的 `--fix` 收掉） |
| `bash scripts/pre-push-checks.sh` | **EXIT=0**（敏感词零命中 / README 双语锚点一致 / 发布提醒 ✓） |

## 四 未取证（具名，不许含糊）

**真窗口点击读数未取**。原因是一条硬闸门：本机 8 GB，取证那一刻 `vm_stat` 空闲页 **4233 ≈ 66 MB**、`sysctl vm.swapusage` 已用 **8797 M / 9216 M** ⇒ 按仓规不起 `build:e2e` + Electron（起真窗口会把机器推进 thrashing）。

因此**这一条我按未取证如实记**：本单元的界面闭环目前只有**渲染层测试**（jsdom）与**主进程真文件系统**两类证据；「真窗口里勾选 → 点 Remove → 行消失」这一步**没有**真机读数。它不许被读数表里的绿点读成已验。

配方（留给会话或下一次内存允许时；一次取完即撤）：

1. `npm run build:e2e`（**必须**，e2e 跑的是 e2e 产物）；
2. 一次性 spec：在**隔离数据根**的 `plugins/` 里先放一个**真部署**（调产品自己的 `deployPlugin`），再 `--user-data-dir` + `PURESCIENCE_STORAGE_ROOT` + 独立端口起实例；
3. 断言顺序：打开 **设置 → Specialists → Add specialist → Import ZIP** ⇒ 勾选前 **Remove 禁用** ⇒ 勾选后点击 ⇒ 屏上出现 `Removed <id> — freed N bytes` ⇒ 该行**消失**（重读列表后为空）；另放一个**无记录**的目录 ⇒ 它上屏为 `no deployment record; this app did not deploy it` 且**没有** Remove 控件；
4. 收尾：停进程、确认端口无监听、删隔离根（先 `chmod -R u+w`）、真实数据根条目数复原。

## 五 本版仍未做的（承接，不许含糊）

- **一键「替换 / 更新」不在本单元**：本单元给的是**移除**（`remove`），替换 = 先移除再部署（两步，读者自己走）；CHANGELOG 里「无法在应用内替换」这半句现在变成「可以两步替换，但没有一键更新」。
- **运行一次的批准授权面**（v2.3.0「明确没做」①）不在本单元，仍由会话那条线负责。
- **插件的 `onDiskBytes` 取自应用自己的目录统计件**：它读不出目录时与「目录是空的」同形（该件既有行为），本单元没有为它新造第二套测量。
