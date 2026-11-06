# 排期档复选框核对（2026-11-06）

> 起因：`docs/plan-2026-11-04-v2.22-v2.27-schedule.md` 的 `[ ]` / `[x]` 是写时的意图，不是当前状态。
> 本档把每一条对着**代码与实机命令**复核一遍，结论只写本轮真读到的；读不到的写「未核」。
> **取证基线一律是 `origin/main`（`2f0f54a1`）**，不是工作树 —— 见末尾那条陷阱。

## 一 v2.22.0 更新通道与自陈更正

| 排期行 | 结论 | 证据（均在 origin/main） |
| --- | --- | --- |
| `statics.zerolink.com` 换成可达 feed | ✅ 已落地 | `electron-builder.yml:170-178`：`publish.provider: github` / `owner: naiyixi` / `repo: PureScience`；注释写明原先那个镜像主机从未解析、每次首检必失败 |
| README 删「51.8 s unoptimised」自陈 | ✅ 已落地 | `README.md:26` / `README.en.md:26`：已改成「a cold start this file once put at 51.8 s measures **2.26 s** … that earlier number is withdrawn, not optimised around」 |
| 更新提示明说 mac 须手动重装 | ✅ 已落地（九语齐） | `UpdateDialog.tsx:170` 用 `update.macManualInstallNote`；该键在 `src/renderer/src/i18n/` 下 **9/9** 个语言文件各一条（`git grep -l … origin/main` = 9） |
| `TeamIdentifier=87G9WFU9H3` 换自有证书 | ⛔ 外部阻塞 | `git grep 87G9WFU9H3 origin/main -- src` **零命中** ⇒ 产品代码里已无该常量；只剩 `scripts/macos-update-cache-drill.mjs:282` 与 `release-certification-evidence.test.ts` 里的**判定基准**。换证书要 Developer ID，属 v2.27.0 采购项 |

⇒ **v2.22.0 已无代码待办**；剩那条只能随证书一起解。

## 二 v2.23.0 性能预算与流畅度

| 排期行 | 结论 | 证据 |
| --- | --- | --- |
| 先修测量方法（p90 在软件光栅下饱和） | 🚧 部分 | 口径已在 `docs/evidence/2026-11-04-perf-baseline.md` §0 立住：同构建两次运行差 **1.6–2.0 倍**（`task=99.0ms/turn` vs `198.7ms/turn`），并写明「单次运行不能宣称变快/变慢，判据要 n≥3 取中位数」。**未做**：这条口径还没落进 `e2e/perf` 的代码（没有自动多次取样与饱和标记），目前靠人读文件遵守 |
| 四项预算达标 | 🚧 未完 | 基线读数在档，达标判据未取 |
| 长会话 / 大项目列表结构性优化 | 🚧 需拍板 | 排期自标「是否做，需拍板」 |

⇒ 这是当前**唯一有实质代码待办**的版本段，且第 1 条可无人值守做（改仪器、不改产品）。

## 三 v2.24.0 分发

| 排期行 | 结论 | 证据 |
| --- | --- | --- |
| npm 发布 `@zerolink/purescience` | ⛔ 阻塞在凭据 | `npm whoami` → `npm error code ENEEDAUTH`（本机未登录 npm）。按纪律不猜凭据、不代填 token |
| Homebrew cask | ✅ 已落地（文档未推） | 真实 tap 仓 `naiyixi/homebrew-tap` 有 `Casks/purescience.rb`（1028 字节）；本仓安装段与校验值复算记录在本地提交 `f10fb8d9`（`docs/evidence/2026-11-05-distribution-cask.md`，**尚未推送**） |

## 四 v2.25.0 / v2.26.0 —— 全部已交付

| 排期行 | 结论 | 证据 |
| --- | --- | --- |
| v2.25 四件（检索框 / Zotero / OCR 九语 / 阅读顺序） | ✅ 已勾，与代码一致 | 排期档自身 `[x]`，本轮不复核 |
| 导出案例包 | ✅ 已交付 | `src/main/cases/export-bundle.ts` + `import-bundle.ts` + `src/shared/case-bundle.ts`（v2.26.0 CHANGELOG「案例包格式 / 写盘·读入 / 两个入口」） |
| 案例市场本体 | ✅ 已交付 | `src/main/cases/marketplace.ts`（GitHub Release 上的索引 JSON + 每案例一个 `.tar.gz`，下载边算摘要）+ `src/main/cases/publish.ts` + `CaseMarketplace.tsx` / `PublishCase.tsx`；真机读数在 `real-publish.local.test.ts`（本机真实项目 10 文件 / 1,808,617 字节上传 `case-index`，读回摘要一致）。发布页 `案例市场索引（测试）`（tag `case-index`）就在 Releases 列表里 |
| 技能放量、README 分层 | ⚠️ 未核 | 本轮没核，不臆断 |
| arXiv / Zenodo 可引用 | ✅ 已交付 | arXiv：`src/shared/citation/bibtex.ts:141` 写 `eprint`、`ris.ts:81` 写 `AN: arXiv:…`；Zenodo（DataCite DOI）：`src/main/references/service.ts:264` `DATACITE_DOI_URL='https://api.datacite.org/dois/'`、`:379` `sourceConnector: 'datacite'`，且 `session-package/import-evidence.ts:66` 认这个来源 |

## 五 案例命名落进数据（属 v2.27.0 未发布段）

🚧 **在制，归并行会话**：工作区里 `prisma/schema.prisma` 的 `caseTitle`、`src/main/projects/repository.ts:87-89`、
`src/shared/projects.ts:13`、`UserCases.tsx:103` 与两侧测试**都是未提交改动**；`origin/main` 的 CHANGELOG 头
（`v2.27.0 — 未发布（签名与公证；案例名落进数据）`）已把它记为本版范围。⇒ 本轮一个字节没碰。

## 六 v2.27.0 签名与公证

⛔ 全段阻塞：缺 Developer ID 证书（采购 1–3 周）。`spctl` 现读数仍是 ad-hoc；没有可无人值守推进的部分。

## 七 本轮形成的判断

1. **可无人值守推进的只剩 v2.23.0 第 1 条**（把 n≥3 中位数与饱和标记落进 `e2e/perf`），不碰产品代码、不碰并行会话在制的任何路径。
2. npm 发布与签名公证都卡在**必须由用户提供的凭据/采购**上，不是代码缺口，不该再被记成「未开工」。
3. 排期档 v2.26.0 那四行 `[ ]` 已全部落地（导出 / 市场 / 命名除外的那条归 v2.27），下一轮不要重做。

## 八 取证陷阱（本轮实测，代价：差点把两个已交付能力报成缺口）

**共享工作树落后 `origin/main` 好几笔，按工作树 grep 会得到"零命中"的假缺口。** 本轮实测：在工作树里
`grep -rn "casePackage"`、`grep -rn zenodo src/` 都近乎零命中，于是初稿把「案例市场本体」和「Zenodo 可引用」
判成缺口；实际两者都在 `origin/main` 上（`src/main/cases/marketplace.ts`、`src/main/references/service.ts:264`），
只是工作树的 HEAD 停在 `v2.25.0` 那一代文件上。

**判据**：核「某能力在不在」时一律 `git grep … origin/main -- <路径>` 或先
`git show origin/main:<文件>`，不要对工作树取数；工作树只能证明「并行会话此刻在写什么」。

## 九 补记（2026-11-06 23:5x，同一夜间）：§二 的「唯一待办」已被交付

§七 结论 1 说「可无人值守推进的只剩 v2.23.0 第 1 条（n≥3 中位数 + 饱和标记）」——**这条在写完之后就被做掉了**，
本档的结论按当时为真、现已过时，就地更正：

| 当时的判断 | 现在的证据（`origin/main`） |
| --- | --- |
| 「n≥3 取中位数」这条口径还没落进代码 | 已落地：`scripts/perf/measure-median.mjs`（`9e6effbf`），四个交互场景各带负载带（`32f84b99`） |
| 「饱和标记」只靠人读文件遵守 | 已落地：仪器自证 idle cadence ≥50 fps 才把帧距当读数；确定性计数（行渲染 / 容器渲染 / markdown 解析）成为判据（`b01dd7b3`、`render-count.spec.ts` 末段） |
| 「四项预算」缺读数 | 滚动一项已达标（p50 17–18 ms、≥200 帧、0 个 >50 ms 任务）；每回合成本的增长机制已定向（`83636513`：增长在**单价**而非次数，代价正比于文档元素总量） |

⇒ v2.23.0 剩下的**不是**「先修测量方法」，而是：① 「四项预算」里绝对 50 ms/回合这一档在本机**不可判**
（宿主 load 与 swap 让同代码量到 57 与 189 ms），要判必须独占测量或专用 runner；② 「长会话结构性优化」
已被 `83636513` 裁到「减每行 DOM 节点」这一条，且判据要先有节点计数（本轮补上：
`docs/evidence/2026-11-06-row-node-budget.md`，每行中位 31 节点、40 与 160 回合不变）。

**教训**：本档这类「只剩 X」的结论有保鲜期。写「唯一待办」时同时写**复核时刻的 `origin/main` SHA**，
下一轮先用 `git log <SHA>..origin/main -- <路径>` 看它有没有被做掉，再决定动手。
