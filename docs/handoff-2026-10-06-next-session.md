# 交接：下个会话从这里开始（2026-10-06）

写给下一个会话：**先读这份，再动手**。所有事实取自仓库当前状态，不是回忆。

## 0. 一句话状态

`main` 上 **v1.86.0 之后已累积 30 笔提交**（本会话 10 个单元 + 自主执行器的 IC39/IC40）⇒ **下一版 v1.87.0 应收未收**。
排期档里本会话**可独立认领的单元已全部做完**；剩下的是执行器正在实现的 **IC42**，与需要立项或拍板的 **IC52–IC56**。

## 1. 环境与并发（最重要，先读这节）

- 工作目录 `/Users/totota/purescience`，分支 `main`。
- **有一个自主执行器 cron `2be4405e5dc6`**（每 120 分钟，workdir 同仓）：它会**自行认领并实现排期单元**，工作期间在工作区留下**未提交改动**。写这份时它正在做 **IC42（引擎面板）**，在飞约 18 个文件（含 `src/main/compute/*`、`src/preload/*`、`src/renderer/src/i18n/*`）。
- ⇒ **三条纪律**：
  1. 不要与它同改一批文件；
  2. 它占着 `src/preload/**` 与 `src/shared/renderer-contract-catalog.ts` 时，不要开需要**新通道**的单元（会被它顶掉或互相踩）；
  3. 它占着 i18n 八个键文件时，避免用会**整份重写**键文件的脚本；要加键就增量插入、逐键核验。
- ⇒ **取真机读数时，若工作树被执行器的半成品污染**：`build:e2e` 编的是**工作树当前内容**，会把它们的代码编进主进程包 ⇒ 应用起不来、spec 报 `electronApplication.firstWindow: Timeout`。解法（零干扰）：
  ```bash
  git worktree add /tmp/ps-<name> <已知干净的提交>
  cd /tmp/ps-<name>; ln -sfn /Users/totota/purescience/node_modules node_modules
  cp <主树>/e2e/certification/<待验>.spec.ts e2e/certification/
  npm run build:e2e && npx playwright test e2e/certification/<待验>.spec.ts --workers=1 --reporter=line
  # 取到读数后：git worktree remove --force /tmp/ps-<name>
  ```
  判断"是不是被别人的代码污染"：另跑一个**与本次改动无关的最小 spec**，它也挂在 `firstWindow` 即可自证。

## 2. 未完成的任务

### 2.1 排期档里仍未完成的行

| 行 | 内容 | 状态 |
| --- | --- | --- |
| **IC42** | 引擎面板：可用性矩阵 + 权重下载同意门与进度 | 🚧 立项与现状核实**已完成**（`docs/plan-2026-10-06-IC42-engine-panel.md`，含三条**改变做法**的实测结论）；**实现由执行器在做** |
| IC10 | 会话包**随包证据落库**（citations / review-findings / verifications） | ⬜ 未做。验收口径：跨实例导入后接收方**三张表真的有行**（现在只读 `conversation.json`） |
| IC52 | 对手 #3140 会话级重放 + 讨论录制步骤 | ⬜ 新批次，**需先立单独立项文件**；先做「只读重放视图 + 对某一步提问」，不做整会话确定性复现 |
| IC53 | S3 增量全文索引 | ⬜ 大件（索引 + 失效策略 + 验收） |
| IC54 | M2 本地解析模型资产 | ⬜ **无已发布 SHA256 的权重不下载** |
| IC55 | 连接器补件第二/三批（PDB 序列 / GEO 矩阵 / Cellosaurus / Monarch） | ⬜ 并批铺完再统一验收 |
| IC56 | Windows 交付面（标题栏菜单 + 代码签名） | ⬜ **等证书与主体拍板**；两项一起做 |

### 2.2 具名立案（已落档、读数或实现未完成）

- **IC50**：技能详情读数。**配方已缩到最后一步** —— 把搜索限定到**技能网格自己的 `input[type="search"]`**（`aria-label = settings.searchSkills`），**不要**用 `getByRole('searchbox').first()`（那是设置对话框的面板搜索）；收窄到那一条后再点其**行名字按钮**进详情，断言 `[data-slot="skill-imported-kept"]`。已落树的只有跑绿的目录探针 `e2e/certification/skill-catalog-seed-probe.spec.ts`（钉死种子配方：`<存储根>/skills/imported/<slug>/SKILL.md` 会被应用目录列出）。
- **IC33**：出网审批卡的**真审批事件**读数（需"真被拦的子进程请求"夹具；配方见排期档该行）。
- **IC30**：窗口侧「导入结果不渲染」那半（自 v1.85.0 立案）。
- **IC16 / IC17**：进度管线富字段未达渲染端；**IC13**：窗口无法完成卸载；**IC14**：启用通道收运行时 id 会崩、带外移除不失效活绑定。
- **新功能立项**（不在原行里假装已有）：期刊合并的**撤销/拆分入口** · RO-Crate **导入外来 crate** · 技能**导入版分叉为个人技能** · 通知**单条删除 / 一键清空**（`deleteSessions` 已是内部清理，面窄）。

## 3. 没有发完的版

- 已发布位点：**v1.86.0**（Latest；`package.json` 也是 1.86.0）。
- **未发布内容 = v1.86.0 之后的 30 笔** ⇒ **下一版号 = v1.87.0**（版本号取自**上一个已发布位点**，不要照批次标签连抬）。
- 发版流程（本仓既有做法，缺一不可）：
  1. `hermes cron pause 2be4405e5dc6` —— **发版窗口不许并发推送**；
  2. 全量门禁：`npx vitest run --maxWorkers=4`、`npm run typecheck:node`、`npm run typecheck:web`（内存紧张加 `NODE_OPTIONS=--max-old-space-size=4096`）、`bash scripts/pre-push-checks.sh`；
  3. CHANGELOG 写 `## v1.87.0` 段（含**成熟度自陈**与**明确没做**逐条具名）、README 双语横幅、`package.json` 升版；
  4. 打 tag 推送 —— **附注 tag**：查 CI 必须 `git rev-parse "v1.87.0^{commit}"` 取**提交** SHA，用 tag 对象 SHA 查 `head_sha` 会永远返回空；
  5. 盯三条车道（Release / Nightly / Windows Full Test）：**连续快推会互相取消，只认最后一笔**；红了先读**作业级注解**归因（`gh api .../actions/runs/<id>/jobs`），**不要重跑单个 job**（会产生同名重复产物）；确需重来就**删 tag 重建**出全新运行；
  6. 核 Release 页（资产数 / Latest / 非草稿 / 正文），最后 `hermes cron resume 2be4405e5dc6`。

## 4. 已完成（本会话，可核对）

v1.86.0 之后本会话交付 **10 个单元**：IC51 · IC45 · IC44 · IC49 · IC48 · IC43 · IC41 · IC50 · IC46 · IC47。
各自的证据等级与读数原文都在排期档对应行（跑绿读数：10.5s / 11.6s / 5.6s / 6.9s / 11.4s / 10.5s+14.3s / 15.5s / 8.8s）。
自主执行器同段交付 **IC39 / IC40**（含启动计数的真因）。

## 5. 会咬人的坑（都已写进技能，这里列"下次一定还会遇到"的）

- `build:e2e` 编的是**工作树当前内容** ⇒ 并发时会把别人的半成品编进主进程包（症状：`firstWindow` 超时）。
- Playwright 的 `getByTestId` 找 `data-testid`；本仓组件常用 **`data-slot`** ⇒ 混用就是"元素不存在"，而渲染套件（`querySelector('[data-slot=…]')`）同时全绿。
- **`<textarea>` 的文本不进 `innerText()`** ⇒ 要读 `inputValue()`。
- 一次性读（`innerText` / `page.evaluate`）之前必须有一条**会重试**的断言 —— `toBeVisible` 不等内容。
- 本仓 vitest **没有 `it.fixme`**（实测 `TypeError: it.fixme is not a function`）⇒ 要挂起用 `it.skip` 并注释写明"挂起而非静默跳过"。
- React 受控组件：直接赋 `.value` 不触发 onChange ⇒ 用原生 setter + 该元素**真正发出**的事件（select 用 `change`、文本域用 `input`）。
- **定位器与交互方式先查再写**（本会话因此白跑三次：`Add category` 实为 `New category`；建分类要点 `Create` 按钮而不是按 Enter；通知中心的 aria-label 是 **"Message center"**）。
- 要验"某件后台事应该发生"，先列全它的**前置开关**并在 spec 里显式做到（例：记忆总开关未开时回忆**本就不该发生**，产品是对的）。
- 面板的"**落地视图**"与"**对象视图**"是两屏：重开设置后面板停在列表 / 分类列表，需**先选中目标**再断言。

## 6. 文献位置

- 排期档（哪条做到哪、证据与配方）：`docs/plan-2026-10-03-interaction-closure-schedule.md`
- 队列档（每轮裁决与教训；§十六/十七含本会话）：`docs/plan-2026-10-03-next-queue-and-round-convention.md`
- IC42 立项：`docs/plan-2026-10-06-IC42-engine-panel.md`
- 技能（大量可复用规程：e2e 定位、通道登记面、发版与 CI 纪律等）：`~/.hermes/skills/software-development/` 下对应目录。
