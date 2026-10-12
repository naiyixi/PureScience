# 交接：v2.0.0 排期续做（2026-10-12 落档）

> 一句话状态：**v2.0.0 的 P0 稳定性批次已全部交付并各有真机读数；D（结构工作台）刚开工（D1 三刀已落地）；D2 勘明已毕未开工；D3–D7 与 A1–A7 未开工。按用户明确要求：P0 + D + A 全部做完才发版，不允许把 D/A 移出本版。**

## 0. 起手三件事（照做，别跳）

1. 加载**本仓的开发技能**（技能目录名含借词，按仓规**不写其名**；真名见会话里的交接提示）—— 本仓的全部纪律与坑在这份技能里（发布核验、门禁、真机取证、i18n、契约 pin、并发执行器共存、技能自带脚本 `scripts/release-gate.sh` / `scripts/find-contract-pins.sh` / `scripts/add-i18n-keys.py`）。
2. 读 `docs/plan-2026-10-10-v2-line-schedule.md` —— **权威排期档**：v2 版本表 · P0 批次（含状态列）· **D1–D7 与 A1–A7 的单元表（每单元带差异化超越点与真机验收判据）** · D2 开工勘明 · 进度台账 · **发版八步** · 并发与环境表。
3. `git fetch -q origin && git log --oneline origin/main -3 && git status --short && hermes cron list` —— 确认当前位点、**共享工作树里执行器的在制品**（那批未提交路径不是你的）、以及在跑的车道。

## 1. 环境与并发纪律

- 仓库 `/Users/totota/purescience`；远端 `naiyixi/PureScience`；本地与远端保持同步。
- **另有一个自主执行器**在写同一棵树（cron `2be4405e5dc6`，每 2h，当前 active）。开工前看它的未提交路径；目录不相交才并行；**只 `git add` 自己的路径，永不用 `-A`**。
- **任何一次 push 都会取消同 ref 在跑的车道**（release 作业尤其怕这个）⇒ 发版窗口先 `hermes cron pause 2be4405e5dc6`，核对完 Release 页再 `resume`。
- **三套根**（先打印接口自报的 `dataRoot` 再断言）：配置/DB 根 `~/.purescience-project`（库 + `-wal`/`-shm`）≠ **dev 存储根** `~/PureScience-DEV`（`runtime/pkgs`、`notebooks`）≠ **打包根** `~/.purescience`。
- 取真机读数前先 `vm_stat`（空闲物理页会在 70 MB ~ 1 GB 间大幅波动）；**优先走 RPC**（`storage:get-info`、`storage:sweep-duplicate-content` 等在 Web 面上可达，零 UI/零 Electron 成本），需要界面时再走"独立工作树 `build:e2e` + 隔离三件齐 + CDP"。

## 2. 已交付（可核对）

| 内容 | 提交 | 读数落点 |
|---|---|---|
| **P0-1…P0-10 稳定性批次**（15 项） | `6c24323d` … `67febe74` | 我 8 项 + 执行器 6 项；读数散见 `docs/evidence/2026-10-1*.md` |
| **D1 第一刀** mmCIF 加载 + pLDDT/按链配色 + 重置视角 + 5 键九语 | `7cccf71b` | — |
| **D1 第二刀** 预览 10 处文案进 9 语字典 | `3d3e9e5f` | — |
| **D1 第三刀** 真数据抓到的格式判别缺陷（真 mmCIF 被内容兜底判成 pdb）+ 复现用例 | `f5e0aba1` | `docs/evidence/2026-10-12-d1-live-structure-format-reading.md` |
| D2 开工勘明 + 单元进度台账 | `11c61589`、`969d95a4` | 排期档内 |

## 3. 未完成（每条带 `blocked-by` 与开工方式）

| 单元 | blocked-by | 开工方式（已勘明，别重新推导） |
|---|---|---|
| **D1 余项**：焦点/选区相机 | 选区由 D3 引入 | 与 D3 同批做 |
| **D2 结构状态进对话** | 无外部条件；**要一次做完四部分** | ①选择模型 + **选择指纹**（结构 id + 链 + 残基区间 + 视图参数 + 内容哈希；同一选择复算同一指纹）为纯函数，可先落地并被 D3 复用；②"选择状态上行"通道（**新通道 ⇒ 契约 pin 串**：契约目录 + preload + 应用命令表 + 本地 Web 可调用面计数 + 各族 IPC 适配器与 local-only 集；用技能自带的 `scripts/find-contract-pins.sh <family> <兄弟通道名>` 打落点，**加/删契约条目后跑全量单测**）；③注入缝接线：`AcpPromptPreparationOwnerOptions` 加**可选** `inputNotice?: (request) => string`，在 `let preparedContent = prepared.content` 处非空则前置，**空串时内容逐字节不变**（镜像既有的 `<purescience_notebook_continuity>`）；**绝不能放 `request.text`**（`prompt-turn-workflow.ts` 从该字段记录用户消息，前缀进去就变成"用户说过的话"）；④上下文里必须带**范围**，不许用"当前那个结构"这类指代。测试要钉三者：provider 内容带块 / resolver 收到的是用户原文 / 无话可说时内容与改前逐字节相同。 |
| **D3 选择与测量即证据** | D2① 的指纹 | 选择/测量落成可复算指纹 → 溯源面板可回跳；判据：同一选择复算出同一指纹 |
| **D4 标签与图层 / D5 中文口语→选择 / D6 导出与动作过门 / D7 结构产物打通** | 前置单元 | 逐条照单元表的差异化点与真机判据 |
| **A1–A7 中文文献翻译** | A1 是其余前提 | A1 段落级检查点（段落 id + 页码 + 原文哈希）→ A2 三模式 → A3 溯源回跳 → A4 术语一致性（复用 100 行 MeSH 表，偏离具名标注）→ A5 参考文献保真 → A6 具名缺态 → A7 导出对照件 + 9 语 i18n |
| **发版本身** | **P0 + D + A 全做完** | 排期档 §三 的八步照抄执行 |

## 4. 发版纪律（用户明确要求，不许改范围）

- **不允许把 D/A 移出 v2.0.0** —— 我 2026-10-12 试过一次"首发只装稳定性批次"，被明确否掉；排期内容必须做完才发版。
- 四文件：`CHANGELOG.md`（本版段 + 成熟度自陈**双向**核对）、`README.md`、`README.en.md`（头部块**逐字节一致**，`node scripts/check-readme-sync.mjs` 是判据）、`package.json`（只抬版本位；**版本号取自实际上一个已发布版本**，从我核到的 Release 页读数取）。
- 门禁：技能自带的 `scripts/release-gate.sh <要打 tag 的那个提交>`；**三条硬要求**（`docs/evidence/2026-10-12-gate-instrument-findings.md` 第四节）：① **门禁运行期间不动主树**（今天那次判决不可归因就是因为我在它跑到一半时回退了提交：日志里两环一个打 2.0.0、一个打 1.102.0）② 只认汇总行 + **每环全文**（现在固定落 `/tmp/release-gate-<sha8>-<环名>.log`，失败会烤尾部 40 行）③ 在要打 tag 的提交上跑。
- 单独再跑一次 `bash scripts/pre-push-checks.sh; echo EXIT=$?` 读退出码（汇总行不可采信）。
- tag 必须指向在远端 main 上的提交；发版后按"资产清单 + `RELEASE-CERTIFICATION.json` 的 `sourceSha` 与 `<tag>^{commit}` 逐字符比对"核验；两条 `notarize-mac` 作业无 Apple 凭据 ⇒ **具名跳过，不许写"已签名/已公证"**。

## 5. 本批踩过、会复发的坑（已入技能）

- **新测试文件一旦 import `createProjectDbClient`/`ensureProjectSchema`**，必须登记进 `vitest.config.ts` 的 `DATABASE_TEST_GLOBS`，否则**两个车道同时红**在同一条分区守卫（`860f106d` 双红、`24d6e979` 修复）。
- **`git commit -m` 里禁用反引号**（shell 会当命令替换，把消息挖空、还可能生成垃圾文件）；长信息一律写文件 + `-F`。
- **证据档里不能写旧品牌路径**（`scripts/pre-push-checks.sh` 会拦，只给文件:行号）⇒ **推前自己先跑一次该脚本**。
- **i18n 译文质量门**判"与英文同形"时**改文案、不放宽白名单**（今天 de `Cartoon`→`Banddarstellung`、fr `Surface`→`Surface moléculaire`）。
- **判定逻辑要用真数据验**（自造夹具只会照着实现写）：今天真 mmCIF 一测就抓出"内容兜底只扫 4 KB"的缺陷。
- 一次性资源当场收干净：游离进程按 `--user-data-dir` 匹配清、`git worktree prune`、临时目录删；报告里写**复核数字**（用户库仍在、用户实例 302、条目数）。

## 6. 当前位点

- `origin/main` = 本文件所在提交；本地 = 远端。
- 五环门禁在 HEAD 上**独立重跑过**：`vitest 1248 文件通过 / 16131 passed / 0 failed`、`typecheck:node` exit 0、`typecheck:web` exit 0、`eslint` 0 error、`repo-checks` 通过。
- 执行器持有同一份排期档（它已解冻）。
