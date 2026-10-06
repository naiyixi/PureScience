# IC42 引擎面板：立项与现状核实（2026-10-06）

> 对应 `docs/plan-2026-10-03-interaction-closure-schedule.md` 批次 8 · v1.87.0 的 IC42
> 「**引擎面板**：可用性矩阵 + 权重下载同意门与进度」，以及该档 §3「v1.87.0 IC42（引擎）是新通道组（engine:*），
> 需要契约 + 生成式 API 映射 + 9 语，**单独立项文件**」。
> 本档只做三件事：**核实现状**（逐条 file:line 实测）、**定做法**（含本轮实测推翻的两个直觉做法）、
> **给验收判据**。不重写设计意图。

## 1. 现状核实（逐条对源实测，2026-10-06）

| 事实 | 锚点（实测） |
| --- | --- |
| 引擎目录已存在且**声明齐全**：id/label/kind/outputKind/requirements(gpu·weights·msa)/license(商用限制)/placement | `src/shared/engine-catalog.ts:67-145`（7 条：alphafold-db、pdb、esmfold、colabfold、ddg-cpu-predictor、openmm-fep、rosetta-ddg） |
| 可用性判定是**单一来源**且已是纯函数 | `evaluateEngineAvailability()` `src/shared/engine-catalog.ts:150-197`；结果四态 `ready / needs-consent / needs-host / unavailable`，每种带**具名原因** |
| **窗口面零入口**：全仓无任何渲染层引用 | `grep -rn "engine-catalog" src --include=*.tsx` → **0**；消费方只有 shared 的 `engine-routing.ts` / `remote-job-template.ts` / `ddg-esm.ts` 与 main 的 `compute/skill-doc.ts` / `engines/alphafold-lookup.ts` |
| **agent 面已有投影**（不是零消费，是零**界面**） | `src/main/compute/skill-doc.ts:91` `renderEngineAvailability(hosts)`，`:152` 写进 compute skill doc ⇒ agent 拿得到「哪个引擎能服务这个请求」 |
| 校验式权重下载原语存在、**仍零消费方** | `src/main/engines/model-weight-cache.ts`（`downloadModelWeights` / `modelWeightPath` / `sha256Of`）；`grep -rn "downloadModelWeights" src` → 仅自身与测试 |
| 本轮实测的两个**推翻直觉**的事实 | ① **不得新造本地 GPU 探测**：仓储既有规则写死在 `skill-doc.ts:95-98`——「A GPU is only claimed when a probed host actually reported one; the local machine never advertises a GPU it has not proven」，且 `hasGpu` 由**已探测主机上报的 `probeResult.gpus`** 推出 ⇒ 面板必须用同一条规则，自己写一个 `system_profiler`/`nvidia-smi` 探测会**与 agent 面自相矛盾**（同一个引擎，agent 说不可用、界面说可用）。② **`allowOnDemandDownload: false` 是真实状态**，不是占位（`skill-doc.ts:98` 与 `docs/plan-2026-10-03-M2-blocker-and-deferral.md` §2：没有任何一份「权重 + 发布方校验值」清单） |
| **引擎的可见文案是中文硬编码**（本轮新发现，直接决定工作量） | `engine-catalog.ts:71/75/81/85/91/95/101/105/116/120/126/130/136/140`（label + summary）与 `:164` 起的 reason 模板全是中文字面量；`grep -rn "engine" src/renderer/src/i18n/en.ts` → **0 条** ⇒ 上屏前必须走九语字典 |
| 数据侧事实（面板要用） | 主机列表：`compute:list` → `useComputeStore().hosts`（`ComputePanel.tsx:160` 已在用，含 `probeResult.gpus` / `probeResult.ok`）；引擎目录是 **shared**，渲染层可直接 import ⇒ **本单元不需要新通道** |

## 2. 做法（含两处路线纠偏）

**总原则**：面板是**纯投影**——所有判定读同一份共享来源，界面只负责把事实翻译成人话并按语言呈现。

1. **入口落点**：`src/renderer/src/pages/settings/ComputePanel.tsx` 新增「引擎」分区（该面板已有 `gpu` 关键词，
   且批次名就是「算力与引擎」），**不新开设置面板**——新面板会连带面板注册 / 导航 / 调色板命令 / 搜索关键词四处，
   收益只是多一个侧栏项，与本单元的目标（让引擎可被发现）不成比例。分区标题与说明进九语字典。
2. **零新通道**：矩阵所需事实=引擎目录（shared）+ 主机探测结果（既有 `compute:list` 已投递）+ 权重清单存在性（shared 常量）。
   ⇒ **不新增 `engine:*` 通道**，也就没有契约连锁（目录/preload/本地 Web/远程拒绝/生成式映射/参数形状计数全部不动）。
   先例：S3 的界面读数片（`0b2b220a`）同样「不新增通道，读数搭既有响应」。
   **例外与触发**：若下一步要把**本机**事实（如本机 GPU）搬进面板，就必须回到主进程 ⇒ 那时才立 `engine:*` 通道，
   并按 `references/adding-an-ipc-channel.md` §3/§3b 的清单逐项追平计数（**先不预先猜 pin**）。
3. **文案结构（本单元的主要工作量，也是它不能只加一个组件的原因）**：把引擎目录的**可见文案从字面量改成消息键**：
   - `label` / `summary` ⇒ 键 `engines.<id>.label` / `engines.<id>.summary`；
   - 四种判定态与权重门态 ⇒ 键 `engines.status.<state>` / `engines.weights.<state>`，**原因句由「键 + 参数」在渲染层组装**
     （不再由 shared 拼中文串）；
   - 引擎目录是 shared 层：按本仓 i18n 口径，**shared 只发键与参数、渲染层单点翻译**；
   - 九语（zh/en/zh-Hant/ja/ko/fr/de/es/ru）**一次铺齐**（用 `scripts/add-i18n-keys.py` + TSV，自带九文件齐平预检与写后自证），
     zh ≠ en、zh-Hant 纯繁体、避免与英文同形（`AlphaFold DB` 这类专名可保留，但**不得靠放宽白名单**）；
   - **顺带修一处既有失真**：`skill-doc.ts` 现在把中文 reason 拼进**英文** agent 文档（`needs user consent: <中文>`）——
     改成由结构（状态 + 参数）渲染英文句子，agent 面与界面共用同一份结构。
4. **权重门：先有形态，不做假按钮**。按 `docs/plan-2026-10-03-M2-blocker-and-deferral.md` §3 的纪律
   （「M1 的壳保持现状，**不加『假安装』按钮**」）与 IC54 的前置（「IC42 的权重同意门先有形态」）：
   - 新增 shared 单一来源：权重规格清单常量（**当前为空 = 真实状态**）+ `weightDownloadPossible(specs)` +
     `describeEngineWeightGate(engine, consent, specs)` → 四态 `not-needed / unpublished / awaiting-consent / ready`；
   - 面板逐引擎呈现该门态与理由；**当前所有按需引擎都是 `unpublished`**（无清单 ⇒ 按设计不可下载），
     **不渲染按钮** —— 一个「点了必然被拒」的按钮就是死控件，比没有按钮更坏；
   - 清单落地后（M2 解锁），`unpublished → awaiting-consent`、同意门与进度才有对象，届时再补进度投递（可能才需要新通道）。

## 3. 验收判据（下一步按此收口）

1. **单元/渲染**：`evaluateEngineAvailability` 四态 × 面板渲染（每态有断言）；引擎目录文案**不再有中文字面量**（静态扫描守卫，
   带「扫描文件数 > N」自检）；`describeEngineWeightGate` 四态；「无清单 ⇒ 一律 `unpublished` 且**界面上没有下载按钮**」。
2. **九语**：新键 ×9 齐平、覆盖率 100%、zh ≠ en、zh-Hant 繁体（跑 `node scripts/i18n-coverage.mjs` 与翻译质量套件）。
3. **零契约涟漪的自证**：`npm run check:web-api-map` 不变；`src/shared/renderer-contract-catalog.test.ts` /
   `renderer-surface-inventory.test.ts` / `src/preload/index.test.ts` / `application-command-composition` 的计数**全部不动**
   （本单元不加通道 —— 若被动过，说明做法漂了）。
4. **真机读数**（隔离实例三件齐：`--user-data-dir` + `PURESCIENCE_STORAGE_ROOT` **且同时改 `settings.dataRoot`** + 独立端口）：
   打开 设置 → 算力 → 引擎分区，读回矩阵原文；**且**用「换语言再读」证明文案真的随语言走（这一条同时挡住「键铺了但界面读字面量」）。
   无主机时断言 `needs-host` 行与「GPU 事实来自已探测主机」那句说明在屏上。
5. **实机流畅度**：面板是静态列表，无需专门 perf 车道；但**列数**（7 引擎 × 4 行）必须在真机上确认不溢出。

## 4. 与对标的差异化（不得退让）

- **预测 ≠ 测量**：`outputKind` 在面板上逐行标注，`predicted` 必须显式写出「非实验值」；
- **无已发布校验值即拒绝下载**（本单元以 `unpublished` 门态 + 明写呈现，而不是静默省略）；
- **许可可见**：`license.commercialRestricted` 逐行呈现（商用受限的引擎在科研机构之外使用前必须看得见）；
- **不谎报能力**：不可用的原因具名（缺 GPU / 缺主机 / 无清单），且界面与 agent 面**用同一条 GPU 规则**。

## 5. 实现与未做（2026-10-06 更新）

**已落地（执行器，提交 `8b8111dc`）**：§2 的三条路线全部按本档执行 ——
面板（`EngineMatrixSection`，设置 → 算力，零新通道）、文案结构化成「shared 发键与参数 + 渲染层单点翻译」
（九语 +30 键、覆盖率 3683 ×9 = 100%）、`skill-doc.ts` 的中文 reason 进英文文档的既有失真同批修掉
（新增 `describeEngineAvailabilityEnglish()` + 「整块 agent 文档零 CJK」守卫）；权重门按 §2.4 的「先有形态」
落地四态单一来源，当前一律 `unpublished` 且**不渲染按钮**。§3 的判据 1–3 已由本机门禁满足
（定向 177 文件 / 1887 passed；pin 八套件 133 passed；`check:web-api-map` 通过；双 typecheck 净；`eslint --no-cache .` 0 error）。
§3 的判据 4（真机读数）**未取**，见下。

### 5.1 真机读数（未取，具名立案 + 配方）

开工时 swap **10.32 G / 11.26 G 已用**、空闲物理页 ~4.1k（≈65 MB）⇒ 不具备 `build:e2e` + Electron 的安全余量，
故**未改 `e2e/certification/**`**（未跑过的 spec 进仓＝留一道从未通过的闸门）。配方（下一轮内存宽松时一次跑完）：

1. 隔离实例三件齐：`--user-data-dir` + `PURESCIENCE_STORAGE_ROOT`（**同时**把 `settings.dataRoot` 指到隔离目录）+ 独立端口；
2. 打开 **设置 → 算力**，读回 `[data-slot="engine-matrix"]` 的矩阵原文：7 行（`[data-engine-id]`）、
   每行的 `data-engine-status` 与 `data-weight-state`、输出类型徽标（`Predicted` 行必须带「非实验值」语义）、
   商用受限徽标只在 `ddg-cpu-predictor` / `rosetta-ddg` 上出现；
3. **无主机**时断言 `openmm-fep` / `colabfold` 行为 `needs-host`，且 GPU 规则那句说明在屏上；
4. **换语言再读**（如切到 zh）⇒ 行文案与状态文案真的跟着变 —— 这条同时挡住「键铺了但界面读字面量」，
   是本单元真机读数的关键一半；
5. 断言**界面上没有下载按钮**（`engine-matrix` 内 `button` 计数为 0），把「无清单 ⇒ 不渲染按钮」这条纪律钉在真机上；
6. 列数（7 引擎 × 4 行）在真机上不溢出。

- **解锁前置**（权重半）：按 `docs/plan-2026-10-03-M2-blocker-and-deferral.md` §3 的三个前置（拍板发布方与托管位置 →
  产出随应用发布的 manifest（`id/revision/url/sha256(64hex)/bytes/license`）→ 才能做校验式获取与接入）。
- 面板（矩阵）半**不依赖**上述前置，可先做 —— 它呈现的是「本机/已注册主机现在能服务什么」，本来就不该等权重清单。
