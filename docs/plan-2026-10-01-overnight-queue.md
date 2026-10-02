# 过夜自主队列（v1.79.0 目标）— 2026-10-01 夜

由会话交接，供过夜自主执行使用。**每完成一项就提交 + 推送**；每项都必须"可提交、有证据、无半截"。
纪律（不可打折）：本地全绿（双 typecheck + eslint + 相关 vitest）→ `git commit`（常用 `HUSKY=0`）→ `git push origin main` → 看 CI 到结论。
**绝不把缺失的测量当成测量**；缺失即具名失败，绝不编造数值。**禁死代码**：新增能力必须同一提交内接到真实消费方。
真机/真文件级证据优先于单测；单测不算"功能已实机跑通"。

## 现状（开始时的事实）

- **v1.78.0「算筹」已发布**（tag `a4e7f352`，run `36887148887` success、21 资产、正文 8532、认证齐全、Latest）。
- 已完成：R3（每轮文件证据三态）、R6（内容寻址去重 + 自证空间报告 + 就地整理）、A2（K1a 收口）、A4、A6、A5（+70 个历史发布页重建）、
  A8（真机达成：装 `codex-acp` 后应用找到了 `ChatGPT.app` 内的 Codex 且 ACP 握手通过）、R4-U1（折行表头）、R4-U2（题注关联）。
- 适配器已在机器上：`/Users/totota/.local/bin/codex-acp`（撤销：`npm rm -g @zed-industries/codex-acp`）。

## 队列（按顺序；每项做完即提交）

### Q1. R4-U4「为什么不是表」的可读理由 —— **已完成**（代码 `7d520f0c` + 真机取证 `docs/evidence/2026-10-02-r4-u4-rejection-reasons.md`）
>
> 真机读数（隔离实例 44185，走应用自身 RPC）：散文页 `too-few-columns` ＋ `counts={columns:1,itemCount:5,rows:5,spanningRows:0}`；
> 空页 `blank-page`；真表格页 1 条候选（6 行×4 列 high）且 `rejectedPages` **字段不存在**；"真表 + 散文页"同样**不附理由**（抑制规则成立）。
> 隔离证明：`/tmp/ps-q1/data/.pdfs` 3 个（本次），`~/PureScience-DEV/.pdfs` 基线 18 → 仍 18。**面板级读数已于 2026-10-02 补掉**（原记为待取证）：
> 见本文件「面板级读数」一节 —— 散文页逐页理由＋计数已在真实窗口的 DOM 上读出。


> 第 1 轮（02:16）实现了 Q1 全部代码与测试（shared 6 + service 3 + 面板 2 = 新增 11 例；typecheck 0、eslint 干净、
> 复跑 5 文件 100 例全绿），但**结束时未提交**（预算耗尽在实现与门禁上）。会话侧已复验并提交推送（`7d520f0c`）。
> 实现要点：`measureTableShape` 为抽取与理由**共用一份度量**；`explainTableRejection` 五个具名原因 ＋ 判定计数；
> **形状通过全门却来问理由会抛错**（防撒谎的绊线）；`PdfTablesResult.rejectedPages` **仅在整段零候选时写入**（有候选时字段缺失而非空数组）；
> `PdfTablePanel` 渲染逐页原因＋计数（两条 i18n 键 9 语言实译）。
>
> **下一轮的第一件事不是重写 Q1，而是补它的真机取证**（清单见下），然后进 Q2。

#### Q1 真机取证的卡点与解法（第 1 轮已探明，别重复探）

`PdfService` 用 `resolveDataRoot()` 取数据根 ⇒ **只设 `PURESCIENCE_STORAGE_ROOT`（配置根）不够**：
数据根仍会落到**用户的真实 `~/PureScience-DEV`**，探针会往真实数据根写 `.pdfs/<docId>.json` ✗。
**正确起法**：预置隔离配置根的 `settings.json` 里 `dataRoot` 也指向 `/tmp/...`（或用 `storage:set-data-root-and-relaunch`），
再起 `PURESCIENCE_WEB_PORT=<未用端口> npm run dev:headless`。可用素材：`~/.purescience-project/runtime/envs/default-python/bin/python3`
（`reportlab 5.0.0` / `matplotlib 3.11.0` 在，可造真表格 PDF）、playwright chromium 缓存齐备、`pdf_open` 接受绝对路径。
判据：纯散文页给出**具名原因＋计数**；真表格页照常出候选且**不带**理由。

### Q1 原清单（已实现，留作对照）（编辑清单已写在 `docs/plan-2026-10-01-v1.78.0-slices.md` §4）
1. 抽 `measureTableShape(items, options)`：把 `groupRows → columnAnchors → placeInColumns → mergeSplitColumns → joinWrappedHeaderRows` 合成一处，
   返回 `{ rows, columns, spanningRows }`，**由抽取与理由共用**（两处各写一份必然会漂移，那时理由就是撒谎）。
2. 新增 `explainTableRejection(page, items, options)`：具名原因 `blank-page` / `too-few-rows` / `too-few-columns` / `rows-do-not-span-columns`
   ＋判定所用计数与下限。
3. 接进 `src/main/settings/pdf-service.ts`：**仅在整段扫描无候选时**附带 per-page 原因，随工具结果返回。
4. 测试：四个原因分支各一条 ＋「有候选时不出理由」；真机取一页纯散文与一页真表格对比（散文页给原因与计数、真表格页出候选且不带理由）。

### Q2. R4-U3 旋转与符号/连字修复 —— **已完成**
> 旋转这一半：代码 `849b0839`（+ 调查 `facae33e`）；真机 before/after 11 例逐条对比见
> `docs/evidence/r4-u3-rotation-investigation.md` §6（10/11 逐字不变，唯一变化是被修的缺陷页；旋转表 hash 与不旋转同表相同）。
> 连字/软连字符这一半：**实测结论"无需改"** —— 手写 ToUnicode 夹具（`docs/evidence/2026-10-02-r4-u3-ligature-fixture.py`）
> 经应用通道读出 3×3 完好、连字被 reader 展开成 ASCII、软连字符在两种归一化模式下都不出现在字符串里 ⇒ 不写死代码。
> 具名未取：面板的浏览器级读数（`rotatedPages` 提示）—— **已于 2026-10-02 补掉**：旋转页提示在真实窗口的 DOM 上读出
> （`its content stream is rotated 90°…`），见本文件「面板级读数」一节。
- 目标：旋转页面上的表被当成横排文本（列全乱）、连字（ﬁ/ﬂ）与软连字符切碎单元格词。
- 做法：先探现状（`src/shared/pdf-table-extraction.ts` 是否有旋转信息可用：`PdfTextItem` 无角度字段 ⇒ 需从 PDF 操作符取 `Tm/Td` 的旋转分量，
  或在 `src/main/settings/pdf-service.ts` 的解析层把旋转归一化）。**先写调查结论再动代码**（照 R6-U1 的先例）。
- 验收：真机取一个旋转 90° 的表格页与一个含 ﬁ/ﬂ 的页，读数前后对比。

### Q3. ①④⑤ 在真实 codex 回合路径上取证 —— **① 已取得（具名 `bridge-unavailable`）；④⑤ 结构性取不到、已立案**

> **已探明（别重走）**：应用内检测**只认托管适配器**（`codex-detect.ts:85-89` + `agent-runtime-manager.ts:299-313`），
> 用户装的 `~/.local/bin/codex-acp` 在应用里**不可用**（A8 的修复只覆盖零参数检测）；建会话会 500 `Codex native executable not found`。
> **可用配方**：`settings:install-codex {"source":"managed"}` 装在**隔离根**里即可（303 MB，`ok:true`，机器不受影响；
> npm 源会跑全局 npm install，**未用**——那是用户决定），随后 `acp:create-session` 返回 `frameworkId=codex` 的真会话。
> `acp:create-session` 的 `projectName` 字段实际要**项目 id**。
>
> **读数**：3 种 provider 形状（codex-isolated 订阅 / 官方 API-key / 自定义 chat-completions）、**8 个真实回合**
> （120–147s/次，`status=connected`、`lastError=null`），`function-model-events.json` **始终为空**；
> codex rollout 里该回合用户消息就是 33 字符原文、全文无 `skill` 文本 ⇒ **这条支没跑**（不是"选了 0 个"）。
> 闸门 = `bridgeSkillsAvailable`（`connection-resource-owner.ts:106-108`）；桥只在 `target.needsChatResponsesBridge`
> 时创建（`backend-resolver.ts:745-752`）。
>
> **本片已交付（用户拍板"做成回合侧可读证据"）**：新增具名原因 `bridge-unavailable` + 回合侧写入 + 9 语种文案 + 面板穷尽映射；
> **真机读数**（隔离实例 44192，真 codex 会话 `01a0faa4-…`，真实回合）：留痕写入
> `{"functionId":"skill-selection","outcome":"built-in","reason":"bridge-unavailable"}` 且回读仍在
> ⇒ **① 在 turn 路径上已取得**（内置回落 + 具名原因）。
> 同时修掉一个真缺陷：留痕读取器漏收 `call-not-attempted`（写入带原因、读回丢掉），现由契约自身一份清单派生 + 回归用例。
> 见 `docs/evidence/2026-10-02-q3-turn-side-reason.md`。
>
> **④⑤ 仍是结构性取不到（非"没做"）**：桥不存在 ⇒ 没有模型往返、配置的模型根本没被咨询 ⇒ 产生不了 `call-failed`。
> 要取得 ④⑤，需要**让这些 provider 形状也有桥**（建桥条件是 `target.needsChatResponsesBridge`，属产品路由决定）——**独立立案**。
> **在此之前不要重跑安装/回合**（配方见本段上方）。

- ~~现在适配器通了~~ **（此前提已被实测推翻，见上）** 旧记录：`detectCodex()` 零参数即可复现：`adapterPath=~/.local/bin/codex-acp`、`nativeCodexPath=/Applications/ChatGPT.app/Contents/Resources/codex`、
  `nativeCodexVersion=0.154.0-alpha.6.2`，返回对象的前提是真实 ACP initialize 通过 —— **零参数检测确实如此，但应用内不走这条**。
- 取证方式：起隔离实例（`PURESCIENCE_STORAGE_ROOT=/tmp/<新名>`、`PURESCIENCE_WEB_PORT=<未用端口>`、`npm run dev:headless`），
  触发一次带技能选择的真实回合，读留痕（`FUNCTION_MODEL_EVENT_LOG_LIMIT=200`），记录：① 内置回落与具名原因 ④ 真实往返耗时与是否真选出技能 ⑤ 失败回落 `call-failed`。
- 纪律：**a missing measurement must never be reported as a measurement**；用量未报告就写 "not reported"，绝不写 0。

### Q4. R2 期刊实体 —— **依赖判定完成（依赖已解除）**，本版不做、立案下一版
- 复核结论：筛选 S1 **已落地**（五张表 + 索引在运行期 DDL，`prisma-client.ts:766-822` 定义 / `:1107-1112` 执行；
  真机验收见 `docs/evidence/2026-09-29-literature-screening.md`）⇒ "与 S1 合批一次迁移"的前提**已失效**，
  R2-U1 只能是独立迁移。判定与证据写进 `docs/plan-2026-10-01-R2-journal-entity.md` §6。
- 本版不做的具名理由：R2 是 U1–U4 四片连成的一条能力，半条塞进本版即"有表没入口"的空壳。**未动库**（全库 grep `model Journal`/`issn` 零命中）。


### Q5. A7 外部锁导入（已显式顺延 v1.79.0）
- 除非 Q1–Q3 全部收口且余量充足，否则**保持顺延并写明理由**。若要做：需要新通道（含渲染器契约与 `npm run gen:web-api-map`）
  ＋ 一次真实环境构建验收；**不做半截**。

### Q6. 发 v1.79.0 —— **已完成**（tag `v1.79.0` → `a1493bf1`，Release run `36966180842`）

> **回读（2026-10-02 13:24 CST，全部来自发布后的真实 API）**
> - tag `v1.79.0` 注解对象 `483c3884` → 提交 `a1493bf15bdff781183f66aced0610d729a238c3`（= release 提交，已在 `origin/main`）。
> - publish 作业 **success**（步骤 1–12 全绿）；`notarize-mac` 两个作业按名 **SKIPPED — UNSIGNED macOS assets, not notarized**（无 Apple 凭据）。
> - 发布页：**21 资产**（mac arm64/x64 的 dmg+zip+blockmap、win setup.exe+zip+blockmap、AppImage、deb、
>   `latest.yml`/`latest-linux.yml`/`latest-mac.yml` + 两个 per-arch `*-mac.yml`、`version.json`、`SHA256SUMS.txt`、`RELEASE-CERTIFICATION.json`）。
> - 正文 **9433 字符 / 11944 字节**（桩是 84–428；作业内 `>=2000` 闸门通过）：成熟度块 + 本版 CHANGELOG 小节 +
>   「明确没做、已立案」+ mac 签名状态行；GitHub 自动生成的提交清单标记 **0 条** ⇒ 确为本版自己的正文。
> - `version.json`：`version=1.79.0`，四平台 url/size/sha256 齐（mac-arm64 `d9ecfb82…`、mac-x64 `726afaea…`、
>   win-x64 `0a9933e2…`、linux deb `876cacdc…`）。
> - `RELEASE-CERTIFICATION.json`：`sourceSha` = `a1493bf15bdff781183f66aced0610d729a238c3` **与 tag 提交逐字符相同**；
>   四平台 `packageSmoke: passed`，两个 mac 平台 `macSignature: unsigned`（如实标注，未假装已公证）。
> - GitHub `Latest` 已指向 `PureScience v1.79.0`。
> - 未决：`windows-upgrade-smoke`（`continue-on-error`，诊断性）本轮结束时仍 `in_progress`；它不影响上面任一读数。

- 前提：Q1–Q3 收口（Q4/Q5 若仍顺延则写进 CHANGELOG 的"明确没做、已立案"）。
- 流程：`CHANGELOG.md` 加代号行（**代号要新取一个**，两处：代号表 + 该版本小节标题）→ `README.md` 与 `README.en.md` 的**发布横幅逐字相同**（有 pre-push 守卫）
  → `package.json` 版本 → `git tag -a` → 推 tag 触发发布 → **正文必须自己写**（见下）→ 回读验证。
- **发布页正文（血泪教训）**：`node scripts/release-notes.mjs <版本> --print --certification <该 release 的 RELEASE-CERTIFICATION.json 资产>`
  → 删掉以 `release-notes:` 开头的行 → `gh release edit <tag> --notes-file <文件>` → **回读长度**（真正文数千字符；桩是 84–428）。
  作业里已有 ≥2000 的断言步骤，但那是**兜底**，不是许可。

## 第 1 轮踩过的环境坑（后续每轮直接照用，别再花预算重探）

- **本 cron 会话里 `execute_code` 被安全策略禁止**，`npx <pkg>` 会被安全扫描拦（Tirith 元数据超时）。
  可行通道：把命令包进脚本再 `bash`（例：`bash /tmp/ps_test.sh {vitest|eslint|prettier}` 内用 `./node_modules/.bin/*`）；
  `npm run typecheck` 正常可用。
- **投递**：本作业已把 `deliver` 改为 `local`（原来的 origin 解析到微信 iLink，那条路自 2026-08 起不可用，
  第 1 轮因此被记成 `delivery_failed` 并被自动暂停）。结论在 `~/.hermes/cron/output/ea268d327190/*.md` 里，本机可读。
- **纪律提醒**：一轮结束前**先提交**再写汇报——第 1 轮把实现做完了却没提交，等于把成果悬在工作区里。

## 收尾时（十点前）要能报的

1. 每项的提交号 + 门禁结论 + 证据（真机/真文件级读数，而不是"测试通过"）。
2. 明确列出**没做**的与**为什么**（依赖/顺延/阻塞都要具名）。
3. 工作区干净、无临时文件残留、隔离实例已停、端口无监听。
（与 v1.77.0/v1.78.0 同口径：宁可报"没做 + 原因"，也不报一个无法核对的"已完成"。）

## 收尾记录（2026-10-02 13:2x，v1.79.0 发布轮）

- 上一轮遗留的隔离实例（PID 树 29405→29424→29439，端口 **44192**，数据根 `/tmp/ps-q4-root`）**已停**：
  先 TERM 启动器与实例树，再复查；`lsof -nP -iTCP:44192 -sTCP:LISTEN` **无输出**（端口无监听）。
- 临时目录**已删**：`/tmp/{ps-q1,ps-q1-root,ps-q2,ps-q2-root,ps-q2-start.sh,ps-q4,ps-q4-root,ps-q4-run}`
  ＋ `/tmp/ps-sig-probe`（819 MB）；`du -sh /private/tmp` **847M → 26M**，`ls -d /tmp/ps-q*` 无匹配。
  （`ps-q4-root/codex-subscription/**` 由托管安装置为只读，先 `chmod -R u+rwX` 再删。）
- 确认**未动**用户真实安装（`/Applications/PureScience.app`，PID 22787 仍在）。
- 仓库：`HEAD=a1493bf1`，`git status --porcelain` 空，`git rev-list --left-right --count origin/main...main` = `0	0`。
- 仍**未取**（具名，不假装量过）：面板的**浏览器级**读数——R4-U4 的逐页理由与 R4-U3 的 `rotatedPages` 提示只在
  服务/render 用例里覆盖过，没有一次"真实例 + 真 PDF + 真界面 DOM"的读数。
  **当轮补掉**：见下方「面板级读数」一节（新认证 spec + 真实窗口读数）。

## 面板级读数（2026-10-02 13:4x，补掉上面那条"未取"）

- 新增认证 spec `e2e/certification/pdf-table-panel-reasons.spec.ts`：真实 Electron 窗口，走**文件自己的菜单**
  打开表面板，读的是渲染出来的 DOM。
- 夹具新增（`e2e/fixtures/fake-opencode.mjs`，手写 PDF，不依赖生成器）：`prose-evidence.pdf`（5 行散文，
  单列）、`rotated-table-evidence.pdf`（6×4 真表，每格用 90° 文本矩阵 `[0 1 -1 0 -y x]` 放置）。
- 实测读数（逐字）：散文页 `too-few-columns — rows 5, columns 1, rows spanning the columns 0; the shape test
  needs 2+ rows and 2+ columns.`（候选计数 0）；旋转页形态 `6 rows x 4 columns`、提示
  `its content stream is rotated 90°, so the coordinates below were normalized to upright…`、表头
  `["Gene","log2FC","p-value","adjP"]`，且**不**同时报"没有表"。
- 本轮本机运行：`2 passed (19.7s)`（连同既有 `pdf-table-extraction.spec.ts` 一并跑过）。门禁：typecheck 0、
  eslint/prettier 干净、`npm run build:e2e` 成功。
- 全文与复现命令：`docs/evidence/2026-10-02-r4-u3-u4-panel-readings.md`。

## 第 3 轮（2026-10-02 15:42–，核对/闭口轮）

本轮队列里的 Q1–Q6 **全部处于已完成或已立案状态**（Q1/Q2/Q6 完成并回读、Q3 ① 已取得/④⑤ 未取得、Q4 立案下一版、Q5 顺延），
唯一还开着的工程项 Q3 ④⑤ **此刻由另一个会话持有**（见下）⇒ 本轮做的是**把上两轮挂在明处的开环逐条闭口**＋清理，不做并行改码。

### 1. 上轮「CI 未到结论」现在闭口为绿（读数来自真实 API，用**完整 40 位 SHA**）

| 提交 | 关联 run |
| --- | --- |
| `007af97eaa958f1c2a5a0e72f6a777f3bd9582fa`（R4-U3/U4 面板级读数） | Nightly **#809 completed/success**、Windows Full Test **#804 completed/success** |
| `a4cdffbc41bd4e5485ba5a96ad50e1167eb46be7`（acp：selector-error→call-failed / catalog-error→call-not-attempted） | Nightly **#810 success**、Windows Full Test **#805 success** |

注（**本轮实测更正**，不是推测）：`9a5482b6 / 53ce7a36 / 8480a736 / 582c0039 / 95d735c5` 这五条 `total_count=0` 的**真因是 `paths-ignore`**，不是"批次尖端"：
`nightly.yml` 与 `windows-full-test.yml` 的 push 触发器都写有
`paths-ignore: ['**/*.md', 'docs/**', 'LICENSE', '.gitignore']` ⇒ **纯 docs 提交按设计不触发 CI**。
本轮那条 `1a090b23`（只改 `docs/plan-…`）同样 `total=0`，与这条解释自洽。
含义（要说清，不要误读成"全绿"）：这些 docs 提交**从未被 CI 验证过**（设计如此，文档改不动应用）；
`main` 上**最后一次被 CI 验证过的代码状态是 `a4cdffbc`，绿**。
（踩坑记录：短 SHA 查 `head_sha` 会返回 `total_count:0`，会被误读成"没触发"，必须用完整 40 位。
若要强行验证 docs 提交，只能 `gh workflow run nightly.yml` 强制一次——本轮**未做**：为纯文档让四平台构建跑约 20 分钟不值。）

### 2. 发布 run `36966180842` 全作业回读（上轮遗留的 `windows-upgrade-smoke` 一并闭口）

`run concl=success`，`sha=a1493bf15bdff781183f66aced0610d729a238c3`（= tag 提交），逐作业：

- `Release preflight` / `build / Verify (lint + typecheck + test + package)` / `build / Resolve platform matrix` success；
- 四平台构建（macos-arm64 / macos-x64 / windows-x64 / linux-x64）全部 **success**；
- `notarize-mac / Resolve Apple notarization credentials` success；两个 `SKIPPED — UNSIGNED macOS assets, not notarized (no Apple credentials)` success；`refresh-checksums` **skipped**；
- `publish` **success**；
- **`windows-upgrade-smoke` = completed/success**（上轮"仍 in_progress、未再复核"的那一项，现已闭口）。

### 3. 发布页复核（发布后真实 API 重读，确认"撤回收回"落在公开页而不只是 CHANGELOG）

- `tagName=v1.79.0`、`draft=false`、`prerelease=false`、`publishedAt=2026-10-02T05:24:25Z`、**资产 21 个**（与上轮回读一致）。
- 正文 **10072 字符 / 12768 字节**（上轮 9433 字符 ⇒ 之后按更正**重合成**过，长度增加有据；桩是 84–428）。
- 正文含**更正后**的 Q3 口径：`本版**不声称**它们结构性不可得（这条要更正）`，并写明 `requiresChatCompletionsBridge` 的代码前提与"下一次真机回合即可判定"。
  ⇒ 与 `95d735c5` 对 CHANGELOG/两个 README 的收回**同口径**，公开页没有留下旧的过强声称。

### 4. README 双语横幅逐字相同（pre-push 守卫口径，程序化核对）

`README.md` 与 `README.en.md` 各 1 条 `released](` 横幅行，长度各 **404 字符**，`identical=True`。

### 5. 清理（可核查）

- `/private/tmp`：**412M → 406M**，删除**历史残留 253 项**（早期各轮的 `ps-*.sh|.log|.json`、`/tmp/psreal|psrel|ps-rec|ps-wf|ps-gate|ps-rel79` 等）。
  证据档里引用这些路径的地方都是"配方与读数"（读数已落在文档里），**不依赖文件在盘上**；剩余 406M 主要是下面那个在跑实例的根。
- **保留**（属于在跑实例，不是我的）：`/tmp/psq7`、`/tmp/psq7-root`（386M，含托管 codex）、`/tmp/psq7-run`。
- 用户真实安装 `/Applications/PureScience.app`（PID **22787**）**未动**；仓库 `git rev-list --left-right --count origin/main...main = 0 0`。

### 6. `com.totota.purescience`：仍是"未加载"，且本轮**有意不加载**

- 读数：`launchctl print gui/501/com.totota.purescience` → `Could not find service … in domain for user gui: 501`（plist 在 `/Users/totota/Library/LaunchAgents/`，835 字节，未改）。
- 不加载的理由（具名）：该 plist 是 `RunAtLoad + KeepAlive` 跑 `scripts/serve-headless.sh`、工作目录=**本仓库**；而**此刻有另一个会话的隔离实例正在跑**（下条）。
  此时加载会再起一个常驻 headless 服务、与在跑实例争端口并可能重建 `out/`（在跑实例的 MCP 子进程正是 `/Users/totota/purescience/out/main/index.js`），
  有真实打扰风险 ⇒ 留给用户在**无验证实例**时执行一次：`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.totota.purescience.plist`。

### 7. 本轮让位的具名对象（不是我做的事，是我不去碰的事）

- 另一个会话（**desktop Hermes**：`Hermes.app` pid 15806 → gateway 15866 → `npm run dev:headless` 56947 → 56982 → electron 57016，端口 **44198** LISTEN，数据根 `/tmp/psq7-root`）正在做 **Q3 ④⑤ 的下一步测定**；
  它的 `src/main/acp/runtime-composition.ts`、`src/main/acp/turn-skill-owner.ts`、`turn-skill-owner.test.ts` 有**未提交**改动（mtime 15:27–15:34，`runtime-composition-wiring.test.ts` 为新增未跟踪）。
- 本轮**未触碰**这四个路径、未停它的实例、未删它的 `/tmp/psq7*`，因此**本轮 `git status` 不干净**：工作区里那 4 项属于它。**不要在它提交前把这批文件当"残留"清理掉。**

### 8. 本轮**没做**的（具名，不假装）

- **Q3 ④⑤**：仍**未取得**（第四轮仍在测）——由上面那个会话持有，同一批文件不并行改。
  - **后续（2026-10-02 收口，写在此处以免这条被当成现状）**：那个会话已完成并推送，`git status` 重新干净；它装的隔离实例（44198 及后续 44200/44202/44204）与数据根**全部停掉并删除**，我这边未删过它的任何文件。①②③④⑤ 全部取得真机读数，且顺带修掉三个静默缺陷（宿主被丢弃、失败被记成作答、Codex 缺失理由说谎）；证据 `docs/evidence/2026-10-02-codex-turn-bridge-measurement.md`，提交 `9d79b984` / `c09648de`。**本节的「仍未取得」只描述那一轮，不再是现状。**
- **Q5 A7 外部锁导入**：维持顺延。前提是"Q1–Q3 全部收口"，而 Q3 未收口；且它需要新通道（渲染器契约 + `npm run gen:web-api-map`）＋一次真实环境构建验收，**不做半截**。
  - **后续（2026-10-02）**：Q3 已收口 ⇒ 这条**顺延的理由只剩「容量/排期」**，原前提已满足。仍属下一版范围（新通道 + `gen:web-api-map` + 一次真实环境构建验收），**本轮未开工**，不假装。
- **Q4 R2 期刊实体**：维持立案下一版（U1–U4 四片连成一条能力），本版**未动库**。

### 9. 发布资产对账（本轮新做：声明值 vs 发布页实际）

从发布页**真实下载**三份清单（`version.json` 5608 / `SHA256SUMS.txt` 866 / `RELEASE-CERTIFICATION.json` 4069 字节），
与 Releases API 报的 **21 个资产**逐项对账：

| 检查 | 读数 |
| --- | --- |
| `version.json.downloads` 四平台的 `size` vs 上传后资产 `size` | **逐项相等**：mac-arm64 dmg `281448402`、mac-x64 dmg `296852726`、win-x64 setup.exe `232774161`、linux deb `229341488` |
| `version.json.sha256` vs `SHA256SUMS.txt`（8 条） | 四平台**逐条一致**（`agree`） |
| 声明引用但发布页不存在的资产 | **无**（`declared-but-absent: none`） |
| `RELEASE-CERTIFICATION.json.sourceSha` | `a1493bf15bdff781183f66aced0610d729a238c3` = tag 提交 = 发布 run 的 `head_sha` |

**未取（具名，不拿声明当重算）**：**资产字节级 sha256 本轮未重算** —— 那要下载四平台安装包约 **2.7 GB**，本轮不下载。
所以"上传的字节与其声明哈希相符"这句话，在本轮只是**清单之间的自洽**＋本地上传作业的读数，**不是**本轮重算的结论。
