# H1 —— 用例画廊：卡片打开的就是证据，而不是截图墙

日期 2026-10-31 00:2x CST｜仓库 `/Users/totota/purescience`｜单元 v2.21.0 / H1
落点：`src/renderer/src/pages/home/use-case-gallery.ts`（数据）+
`src/renderer/src/pages/home/UseCaseGallery.tsx`（界面）｜挂载：`HomePage.tsx` 首页正文末尾
守卫：`use-case-gallery.test.ts`（逐字对着证据档核）｜交互：`UseCaseGallery.render.test.tsx`
真机：`e2e/certification/use-case-gallery-evidence.spec.ts`

## 一 缺口与它不该长成的样子

排期档给的现状是「无」，目标是「每个样例可点开读数与原话」。这类能力最容易做成 **截图墙**：
一张好看的图配一句「已在真实环境验证」，读者无法复核，写的人也不必对数字负责。所以本单元先把
判据立成两条可机械检查的：

1. 卡片上的**每一个读数、每一句原话**都必须**逐字**出现在它自己声明的证据档里；
2. 卡片给出的**复跑命令**里点到的文件必须**在盘上存在**。

两条都由 `use-case-gallery.test.ts` 读文件核，不靠自觉。第一条同时挡住了两种漂移：把读数抄错
（`7.8s` 写成 `7.9s`），以及证据档后来被改写而卡片没跟上。

## 二 五张卡片（每张都取自本仓已有的真机读数档）

| 卡片 | 证据档 | 卡片上的读数 |
| --- | --- | --- |
| 外部 MCP 客户端读本机（F1） | `docs/evidence/2026-10-30-f1-external-mcp.md` | `tools/list` 四个名字逐字、`1 passed (7.8s)`、拒绝码 `session-not-found`、审计行 scope `external mcp call` |
| 引文发现（B2） | `docs/evidence/2026-10-29-b2-citation-discovery.md` | `83,700`、`examined=50`、200 行样本 194 行、判据 `doi-prefix` |
| 会话包复算（D1/D2） | `…-d1-session-package-transport.md` + `…-d2-package-readings-recompute.md` | payload 摘要 `d36518b53a7d`、CLI 导出 `326 ms`、导入 `233 ms`、`"state": "match"` |
| 长会话可读性（E1/E2） | `docs/evidence/2026-10-29-e1-e2-long-session-readings.md` | `1 passed (11.8 s)`、`2 steps`、`usage not recorded` |
| DOCX 表格保真（H2） | `docs/evidence/2026-10-30-h2-docx-table-fidelity.md` | `1 passed (7.0s)`、`9 passed`、`43 files / 353 passed`、`3.21 px`、`0.80 px` |

「原话」一栏放的是**产品自己产出的句子**（日志行、拒绝文案、spec 的 console 输出），并注明出处
（`main.log` / 返回给客户端的拒绝文案 / spec 输出），不是我们转述。

## 三 门禁与读数（全部实跑；数字取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向 vitest（内容守卫 + 交互） | **2 files / 7 passed** |
| 内容守卫的变异探针 | 把 `1 passed (7.8s)` 改成 `7.9s` ⇒ **1 failed**，报 `external-mcp: reading "1 passed (7.9s)" is not in docs/evidence/2026-10-30-f1-external-mcp.md`；还原后 4 passed |
| 首页与 i18n 全族 | **10 files / 87 passed**（含 `translation-quality`：25 个新键九语齐平、zh ≠ en、zh-Hant 无简体残留） |
| 真机（`build:e2e` 后 `npx playwright test … --workers=1`） | **1 passed (6.8s)**，同日第二次 **1 passed (7.7s)** |
| 真机的变异探针 | 同一份 spec，把读数改成 `8.1s` 重建后 ⇒ **1 failed**：`Expected substring: "1 passed (7.8s)"`、`Received: … spec1 passed (8.1s) …`；还原重建后复绿（7.7s） |
| `tsc --noEmit`（node / web，`--composite false`，堆 8192） | **0 / 0** |
| `eslint --no-cache`（本批 6 个源文件 + spec） | **0 error**（新文件 4 处 prettier 折行已 `--fix`） |

真机那次 spec 自己的读数行（取自 `test-results/app-process/001-…log` 同轮输出）：

```
[gallery] cards=5 opened=external-mcp readings=MEASURED ON THIS MACHINE tools/list ["list_project_files","list_projects","list_sessions","read_session"] spec 1 passed …
[gallery] quotes=IN ITS OWN WORDS external MCP server started { transport: 'tcp', host: '127.0.0.1', port: 63607, tools: 4 } main.log Cal…
[gallery] command=npx playwright test e2e/certification/external-mcp-client.spec.ts --workers=1
[gallery] copy confirmed, focus returned to the card
```

`copy confirmed` 这条不是「点了就算」：窗口里 `navigator.clipboard` 被 Chromium 权限拒掉，复制走的是
**主进程的 clipboard 桥**，所以按钮变成「已复制」意味着桥真的答了；关闭后焦点回到开它的那张卡片，
是本仓 `useDialogFocusRestore` 的既有契约，这次一并钉在真机上。

## 四 边界（不许读成更强）

1. **五张卡片不是产品能力的清单**，只是「已经有真机读数档、且能一条命令复跑」的那五个。没进画廊
   不等于没做（A 组的发布件读数就还没取到），也不等于做了。
2. **卡片不与运行时联动**：它不读会话、不读证据档运行内容，是编译期挂着的数据模块。好处是一次
   打开是纯本地渲染（零 IPC、零网络）；代价是证据档改写后卡片要人工更新——所以才有第三节那条
   逐字守卫兜底，它会在下一次跑测试时点名哪一条漂了。
3. **不提供「导入这个样例的会话包」入口**。会话包的导入导出是独立能力（D1/D2，三端对称），
   画廊没有为它新造第二条通道；把一个样例变成可导入的包需要一个真包资产随包分发，那是体积与
   授权口径的决定，不在本单元。
4. **语言**：标题/一句话/判据进九语字典（25 个键）；读数、命令、原话保持原文（它们是标识符、
   数值与产品自己的原句，翻译会让它不再可复核）。
