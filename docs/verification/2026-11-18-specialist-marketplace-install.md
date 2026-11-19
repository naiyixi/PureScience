# 专家市场：安装 → 启用 → 绑定 → 跑通（2026-11-18 真机记录）

对象：`naiyixi/purescience-specialist-marketplace` 的 `tcm-evidence-expert`（中医药证据评价专家）。
应用：`PureScience (DEV)`，`electron .` 起法，独立 `--user-data-dir`，真实用户数据根 `~/.purescience-project`。

## 一、安装（界面点击）

| 观察点           | 读数                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 市场列表         | 12 位，标识「官方 · Naiyixi · v1.0.0 · MIT」——验签通过才会渲染                                                                            |
| 详情页           | 技能已选 7/7、连接器 3/3、28.8 KB                                                                                                         |
| 点击「安装专才」 | 侧栏计数 全部 7→8、市场 5→6                                                                                                               |
| 落盘             | `~/.purescience-project/skills/personal/tcm-evidence-appraisal/`（`SKILL.md` + `.specialist-package.json`，含 `contentHash`、`ownerIds`） |

## 二、装完不是马上能用

`specialist/package/transaction.ts:150` 写入 `enabled: false`，并置 `setupPending: true`。列表里该行显示「设置不完整 · 继续设置」，**没有启用开关**；会话的专才下拉只列已启用项，所以此时选不到。

流程是：市场安装 → 列表点「继续设置」→ 编辑器底部「保存更改」→ 才变成 `enabled: true, setupPending: false`。

## 三、绑定与执行

- `window.api.specialist.setSessionSpecialist({ sessionId, specialistId: 'tcm-evidence-expert' })` → 返回 `{ contextReset: true }`（切换会重建 agent 会话，进行中的那一轮被打断并留下 `Session was interrupted before the app closed.`）。
- `window.api.specialist.resolveSessionSpecialist({ sessionId })` → `{ kind: 'bound', profile: { id: 'tcm-evidence-expert', … } }`，返回的 `systemPrompt` 与包内 `system-prompt.md` 一致。

## 四、真实任务与产物

提示词（节选）：对「某中成药治疗 2 型糖尿病，随机、双盲、安慰剂对照，n=120，主要终点 12 周 HbA1c 变化，未报告批号与质控，未说明证候标准来源」按五个维度评价并给结论措辞，禁止给处方与剂量。

回答（3,307 字）证明了包内规范确实生效：

- **声明模式**：开头即 `声明模式：执行`，并自限「只评价这项研究能否支撑疗效结论，不判断是否有效」。
- **五维表**：D1 随机化过程 / D2 偏离既定干预 / D3 缺失结局数据 / D4 结局测量 / D5 结果选择性报告，逐项「有一定风险 / 信息不足 / 低」并写明对结论的影响。
- **中成药补充维度**：T1 复方组成与批次一致性（高关注）、T2 证候诊断标准化（高关注）、T3 安慰剂可行性与盲态完整性（有一定风险）——这是包内「复方批次一致性、证候可重复性」两条的直接落地。
- **GRADE**：起点高 → 偏倚风险 −1、间接性 −1 → **低（暂定）**，并注明若效应量与 CI 缺失则降为极低。
- **措辞校准**：给出「当前信息下只能这样写」与「若全文阳性且信息充分可写」两版，并列出**禁止写法**三条（疗效确切 / 可推荐用于 2 型糖尿病 / 用网络药理支持降糖）。
- **边界**：全程未给处方、剂量与疗程；明确「未获取全文与结果数据」不越界断言。

## 五、顺带修掉的

- `33a30fdb`：旧库 56 行 `caseTitle` 为 NULL，导致首页 `projects:list` 整表读取失败；建表步骤加幂等回填，真应用重启后 NULL 56 → 0，项目列表恢复。

## 六、缺口修复与复验（同日）

两条缺口已改（`3f2bcbdc`）：

1. **装完直接进编辑器**：新增 `postInstallView({setupPending, specialistId})`（`specialist-marketplace-install-outcome.ts`，2 例单测），安装返回后按 `setupPending` 决定落点——未完成设置就进编辑器，那里既有说明也有「保存更改」。原先一律回列表，只有一行小徽标提示。
2. **编辑器说明本地化**：原来硬编码英文（中文界面夹英文），改用 `settings.setupPendingHint`，九语补齐。
3. **中断提示不再谎称关闭**：`INTERRUPTED_SESSION_ERROR` 由 `before the app closed` 改为 `This turn was interrupted before it finished.`，九语 `ui.sessionInterrupted` 同步。原因是同一恢复路径也被 contextReset（切换专才）触发，应用没关却提示关闭前中断。

复验（同一台机器，构建后实机点击）：

- 在市场里装 `radiology-imaging-expert`（36.4 KB，技能 7/7、连接器 3/3），点「安装专才」后**直接落在编辑器**，页面出现中文提示「这个专才已装好但还没启用；点下方「保存更改」完成设置并启用。」，没有回到列表。
- 点「保存更改」→ `enabled: true, setupPending: false`（API 读回，不再需要人工去找徽标）。
- 证据截图 `/tmp/purescience-install-lands-editor.png`。

## 七、第二位专才的实机任务（radiology-imaging-expert）

绑定 `resolveSessionSpecialist` → `bound:radiology-imaging-expert`；任务为评价「AI 低剂量 CT 肺结节检出、AUC 0.94、同院同期、无外部验证」。

它没有硬凑那个虚构设计，而是写明「未指定检查与疾病」后选取可核验的真实证据体（PROMIS mpMRI 分诊研究）按同一流程评价，并交付：

- `PROMIS_mpMRI_影像诊断方法学评价报告.md`（18 KB，QUADAS-2 / STARD 2015 / GRADE / DCA）
- `fig1_promis_accuracy.png`、`fig2_promis_ppv_npv.png`、`fig3_promis_dca.png`
- `promis_analysis.py`（11 KB）+ `promis_metrics.csv`、`promis_ppv_npv_by_prevalence.csv`、`promis_dca.csv`

落盘位置：`~/PureScience-DEV/artifacts/<project>/<session>/message-*/`（已实查文件存在、体积相符）。
结论边界给得准：「可写 mpMRI 适合作穿刺前分诊/排除试验；不可写诊断准确率 93%、阴性即可不穿刺、可替代活检」，并做了患病率重标定（患病率 20% 时 PPV 由 51% 降到 28.1%）。

## 八、界面下拉绑定 + 重启恢复（同日补验）

**界面路径**（此前只走过 API，没点过界面）：会话输入框「智能体控件」→ 鼠标悬停「专才」展开子菜单（7 项，含 `tcm-evidence-expert`、`radiology-imaging-expert`）→ 点选 → `resolveSessionSpecialist` 返回 `bound: tcm-evidence-expert`，会话文件里 `specialistId` 落地。

**发现并修掉一个真缺陷**（`52061a0c`）：

- `SessionBindingService` 的绑定只存在内存 Map，持久化由调用方写进会话文件——但**没有任何路径把文件读回内存**。
- 实测：界面绑好 → 冷重启 → 会话文件仍是 `specialistId: tcm-evidence-expert`，`resolve()` 却答 `main`。界面照旧显示该专才，下一轮由主智能体执行，**无声降级、无报错**。
- 修法：启动时用目录层（不含 messages / conversationGraph）恢复一次；已有内存绑定不覆盖，避免把启动后刚做的切换回退。
- 复验：同一会话冷重启后 `resolve` 由 `main` 变为 `bound: tcm-evidence-expert`。
- 测试：`session-binding.seed.test.ts` 4 例（恢复、不回退、幂等、清除后不复活），`src/main/specialist` **303 通过**。

## 九、另外三位专才抽验（同日）

三位均走「市场 → 查看详情 → 安装专才 → 直接落编辑器 → 保存更改」流程，装完即为 `enabled: true, setupPending: false`：

| 专才                                                    | 绑定解析 | 任务                                                            | 交付（已实查落盘）                                                                                                                 |
| ------------------------------------------------------- | -------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `trial-statistics-expert`（临床试验统计与样本量）       | `bound`  | 两臂 SBP 差 5 mmHg、SD 12、α=0.05、power 90%、脱落 10% 的样本量 | `降压药RCT_样本量估算报告.md`(4.9KB)、`fig_sample_size_power.png`(110KB)、`sample_size_sensitivity.csv`、`sample_size_analysis.py` |
| `guideline-localization-expert`（指南本地化与临床路径） | `bound`  | 把「成人高血压起始联合」推荐本地化到三级医院门诊路径            | `成人高血压起始联合降压_门诊路径本地化方案_v0.1.html`(59.7KB)、`门诊速查卡.html`、推荐对照表与审计指标两个 CSV                     |
| `pathology-molecular-expert`（病理与分子诊断）          | `bound`  | EGFR 19del / PD-L1 TPS 60 / TMB 8 / MSS 的报告审核与证据分级    | `肺腺癌分子病理结果解读与报告要点.md`(7.4KB)                                                                                       |

各自的关键判断（说明包内规范在起作用）：

- 统计：正态近似 122/组、精确 t 检验 123/组，按 10% 脱落给出 **137/组、共 274**；主动指出若真实差值只有 4 mmHg 把握度降到约 74%、3 mmHg 约 50%，并提醒改用 ANCOVA 残差 SD 重算。
- 指南：把国际 Ⅰ/A 与中国 2024 的 Ⅱb/B 分开处理——高危人群强制联合，1 级低危保留单药且**不算偏离**，明确「这是本地化，不是给推荐降级或升级」；随访节点按号源现实改造。
- 病理：坚持「未检测 ≠ 阴性」，要求写明转录本/克隆号/panel 覆盖与阈值；明确 EGFR、PD-L1、TMB、MSI 四者测量对象不同、不能相互推导，也不下诊断结论。

## 十、发现一个新的真缺陷：中断轮次的片段被当作完整回答存下

`pathology-molecular-expert` 那一轮留下**两条** agent 消息：`message-...-10`（617 字，正文在表格中间断掉，且混入了提示词片段）与 `message-...-11`（1017 字，开头写「上一轮聊天文本确实出现了拼接错乱，我在此重新完整交付」）。两条 `status` 都是 `complete`。

所以顺序是：第一次尝试在流式过程中被打断，**半截文本以 complete 状态落库**，随后它作为历史被回放，模型看到残缺上下文才道歉重答。用户视角是「专才突然胡言乱语一次」。

**根因已定位并修复（`d1bb2839`），见下一节；上面这段保留为最初的观察。** 当轮主进程日志（`/tmp/ps-app9.log`）显示同一时间窗内有 `repeated-tool-failure@turn:13` 与多次 `[egress-proxy] egress target failed … ECONNRESET`（网络访问被重置）。因此至少有两种可能，现在的证据区分不了：

1. 流式/落库把半截文本标成了 `complete`；
2. 模型在连续工具失败后自己输出了拼接错乱的内容，本来就被正常完成。

代码侧已确认存在 `failStreamingMessages()`（把仍在 `streaming` 的消息标为 `error`），说明「失败就走 error」的通路是有的；本次两条消息都是 `complete`。

复现条件：稳定网络下重跑同一任务，若再出现拼接错乱才可归因到落库/流式层。本轮不修，记档待复现。

## 十一、拼接错乱的根因（同日定案）与第二个缺陷

### 1. 不是模型，是我们的流式写库丢了字

拿 agent 自己的对话记录（`~/.purescience-project/claude/projects/<workspace>/<acp-session>.jsonl`）与落库内容逐字比对：

- agent 记录：**1166 字**，表格完整；
- 落库：**617 字**，并且是原文删掉了 6 段（262 / 67 / 91 / 80 / 19 / 30 字），其余全部保序。

删掉的位置全在 50ms 合并窗口的边界上。原因在 `projectAgentMessageChunk` 的去重规则：流式文本按 `eventId` 去重，但**一个 ACP 事件可以跨多个合并窗口**，续写的批次带着同一个 id，于是 `chunkEventIds.every(id => message.eventIds.includes(id))` 为真，整批被当成重放丢掉。

改法：id 与文本同时命中才算重放（真实重放会连同文本一起重发，所以幂等性不丢）。回归测试两例：同一 id 的续写必须接上；id 与文本都到过的重放仍要丢掉。

实机复验（新会话 `eddd8fae`，同一病理任务）：落库 **2746 字**，与 agent 记录的 2746 字完全一致，正文没有缺口。

### 2. 输入预检把单位和基因名当成了文件

专才上一轮开头写「系统提示缺失的 `mut/Mb` 与 `HER2/RET/MET`」——那句话不是它编的，是应用写进提示里的。`extractInputPathCandidates` 把「词/词」形状的片段都当路径，`mut/Mb`（TMB 单位）、`HER2/RET/MET`（基因组合）都命中，于是模型收到「这些输入不存在」，第一次回答只能先否认。

改法：必须以扩展名或结尾斜杠收尾才算文件/目录。代价是无扩展名的 `data/2024` 不再被预检——比给模型塞一个假前提要好。

实机复验：同一任务，开头变成「模式：需澄清 + 可先行的方法学判读」，不再出现「缺失」字样。

## 十二、12 位专才全部跑通（同日完成）

12 位市场专才已全部安装、启用并在同一台机器上跑过真实任务，每次绑定都读回 `bound:<id>`：

| 专才                            | 回答长度 | 交付物                                                          | 关键判断（说明包内规范生效）                                                |
| ------------------------------- | -------: | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `tcm-evidence-expert`           |    3,307 | —                                                               | RoB 2 五域逐项；GRADE 由高经偏倚 −1、间接性 −1 到「低（暂定）」；无处方剂量 |
| `radiology-imaging-expert`      |    1,686 | 报告 + 3 张图 + 脚本 + 3 CSV                                    | 选可核验证据体；患病率 40%→20% 时 PPV 51%→28.1%                             |
| `trial-statistics-expert`       |      855 | 报告 + 图 + 脚本 + CSV                                          | 精确 t 检验 123/组，10% 脱落 → 137/组；差值 4 mmHg 时把握度仅 ~74%          |
| `guideline-localization-expert` |    2,219 | 路径方案 + 速查卡 + 2 CSV                                       | 国际 Ⅰ/A 与中国 2024 的 Ⅱb/B 分开处理；1 级低危单药「不算偏离」             |
| `pathology-molecular-expert`    |    2,746 | 报告                                                            | 未检测≠阴性；四项指标不可互推；不下诊断结论                                 |
| `pkpd-dose-designer`            |    1,840 | —                                                               | 线性外推 + 三类失效情形 + TDM 时点；结论限定在人群层面                      |
| `evidence-synthesis-specialist` |    4,925 | —                                                               | 仅规划模式，只给公式与判定规则，拒不给预期效应量                            |
| `clinical-study-designer`       |    1,383 | —                                                               | 事件驱动平行组；随访「最短 2 年、中位 3–4 年」给出依据                      |
| `omics-biomarker-specialist`    |    6,118 | —                                                               | 事件数 34 的限制、训练/验证划分、C-index 与决策曲线报告规范                 |
| `oncology-evidence-expert`      |    2,563 | 报告                                                            | 明确「摘要级效应量」限制，月数换算标注为假设                                |
| `rwe-research-specialist`       |    1,419 | `二甲双胍vs磺脲类_心血管结局_目标试验模拟方案_v0.2.md`（28 KB） | 新使用者设计、immortal time bias、负对照清单                                |
| `example-researcher`            |    1,803 | —                                                               | 说明定位与「缺失/未验证」标注规则，不补看似合理的说法                       |

## 十三、流式丢字：已修复并实测零删除（`b589c465`）

第三次修复后复验，同一台机器、同为「产物型」轮次（会写报告文件的那类，正是之前丢字的场景）：

| 轮次                                 | agent 记录 |  落库 | 删除段 |
| ------------------------------------ | ---------: | ----: | -----: |
| `pkpd-dose-designer`（纯文本）       |      1,840 | 1,840 |      0 |
| `oncology-evidence-expert`（写报告） |      1,783 | 1,783 |      0 |

逐字比对 `SequenceMatcher` 比率 1.0。下面是修复前后的记录，留着说明这条链路上踩过的三个坑：

1. **裸 eventId 去重** → 一个事件跨合并窗口的续写被当重放（1166 → 617）；
2. **按「id + 文本已出现」判重放** → 回答里重复的 `|---|---|` 被整批删掉（6681 → 5681，63 处）；
3. **discard 清空投递计数** → 视图切到产物时计数归零，同一事件重新拿 `~0` 撞号（4147 → 1419，删 2728）。

第三条是乘积：`streamId` 每轮唯一，所以计数保留不会串到别的回答，上限 200 条按插入序淘汰最旧。

## 十三·补记：以前的观察（已由上面收口）

`d1bb2839` 与 `de33e997` 两次修复后：`pkpd-dose-designer` 那一轮落库 **1840 字与 agent 记录逐字一致**（零删除），说明按投递顺序编号的方向对。但随后 `rwe-research-specialist` 一轮仍然丢字：

- agent 记录 4,147 字，落库 **1,419 字**（`SequenceMatcher` 比率 0.51，删 16 段共 2,728 字）。

已排除与未排除：

- 不是模型问题（agent 自己的记录完整）；
- 不是网络（本轮无 ECONNRESET）；
- **怀疑**：`discardStreamedAgentText()` 会清空投递计数器，而视图切到 notebook/产物时会触发 discard；计数器归零后同一事件的后续文本重新拿到 `~0` 编号，与已落库的 `~0` 撞号 → 被判重放丢弃。此项尚未实证。

## 十四、中断态：先前的判断错了，改口在这里

我先写过「中断态会话不接受新 prompt」「continueInterruptedTurn 报 connected 却不续跑」。**这两条撤回**，它们是我绕过界面直接调 API 得出的：

- `api.acp.continueInterruptedTurn` 要求会话**先 attach**；应用自己的恢复路径（`useWorkspaceAgentRuntime.continueInterruptedSession`）顺序是 `reattachInterruptedWorkspaceSession` → `continueInterruptedTurn({projectId, sessionId, promptMessageId})` → `markResumed`。我漏了 attach，main 找不到会话就只回了 `connected` 而不重启轮次。
- 走界面的真实路径是好的：同一会话 `n` 由 13 → 17，agent 回复 46 字与 456 字都落库，说明新 prompt 在中断态下能正常开跑。

**真实存在的问题是另一件**：会话反复落进 `error`，文案有两种——
`Generated file finalization failed: Error invoking remote method …` 与 `This turn was interrupted before it finished.`。
日志里的真因（`/tmp/ps-app16.log:8977` 与 `:9471`，会话 `ff6e5c5b`）：

```
[artifacts:finalization] artifact finalization attempt failed {
  stage: 'durable-finalization', failureKind: 'invalid-proof',
  proofCause: 'root-frame-mismatch',
  rootFrameId: 'root-frame-ff6e5c5b-…', messageBranchId: 'message-branch-ff6e5c5b-…',
  runtimeSegmentId: 'runtime-segment-ff6e5c5b-…' }
Error occurred in handler for 'artifacts:finalize-run':
ArtifactFinalizationProofError: Artifact finalization root Frame does not match the durable Session graph.
```

`artifacts:finalize-run` 抛错 → 渲染层 `recordArtifactError` 之后 **rethrow**（`workspace-events.ts:334`）→ 整轮被判失败、会话置 `error`。

**这条我先写偏过一次，留在这里**：我最初归因到日志里的 `finalizationSkips: 'marker-owned-by-another-session=30, version-context-mismatch=6'`。那是**项目级清扫**的跳过统计，与本轮无关（本轮只有 1 个 Version）。真因是上面这条「根 Frame 与持久会话图不一致」。

最可疑的触发条件：**同一会话中途绑定/切换专才**会做 context reset（`setSessionSpecialist` 返回 `contextReset:true`），而产物的 provenance 仍指向 reset 前的 root Frame；reset 后第一次产物定稿即 proof 失败。今天的验收顺序就是「建会话 → 跑一句 → 绑专才 → 跑任务」，每次都撞。

建议（按优先级）：

1. 定稿 proof 失败不判整轮失败：回复照常交付、产物缺失单独提示、会话回 `idle`；
2. context reset 时把后续产物的 claim 重挂到新 root Frame；
3. `error` 文案带可读原因（现在截断成一句 IPC 错误）。

另一个独立的小问题：产物错误一旦记上就不会被下一轮清掉——`projectFinishedRun` 刻意 `keepArtifactError`，而 `clearArtifactError` 只在**同一轮定稿成功**时调用（`workspace-events.ts:330`）。

## 十四·原始记录：我为什么一度以为 API 坏了（保留）

同一台机器上多次出现：一轮被中断后会话进入 `status: error`（文案「This turn was interrupted before it finished.」）。三种尝试都留了读数：

1. `api.acp.sendPrompt` → **返回成功，但不产生任何新消息**（两次实测 `n` 不变，界面也无提示）。
2. `api.acp.continueInterruptedTurn` 不带 `promptMessageId` → 直接报错 `Resume no longer matches the interrupted turn on the active Conversation Branch (recovery=resume-required:prompt-… requested=undefined status=error)`。这是 API 契约，不是缺陷。
3. 带上正确的 `promptMessageId` → 返回 `{"status":"connected"}`，但**会话仍是 `error`、最后一条仍是无回复的 user 消息**（等 6 秒、再等 45 秒都一样）。这才是缺陷：续跑报成功却不跑。

建议：中断态下收到新 prompt 时丢弃旧轮次并重开（`sendPrompt` 不许静默成功），以及 `continueInterruptedTurn` 的 `connected` 必须对应一次真实的续跑，否则返回失败。

## 十五、绑专才后第一轮偶发「任务发出去却零回复」——日志已定位到 egress

现象：会话建好、开场轮结束、绑专才（`contextReset:true`）之后立刻发任务，任务消息落库、`status` 变 `error`，但 **agent 一条回复都没有**。上一台实例同流程出过 1,783 字完整回答，说明是竞态而非必现。

`/tmp/ps-app17.log` 里同一轮（会话 `ac913c29`）：

```
2287: [acp-prompt-turn-workflow] prompt start { sessionId: 'ac913c29-…', textLength: 135 }
      [acp] reviewer ACP session closed on the agent { … elapsedMs: 19 }
      [egress-proxy] egress target failed { code: 'ECONNRESET', error: 'read ECONNRESET' }
      [egress-proxy] egress target failed { code: 'ECONNREFUSED', error: 'connect ECONNREFUSED 127.0.0.1:53902' }  ×N
```

即：轮次**已经启动**，但 context reset 换掉了 agent 进程，egress 代理转发到的端点随之消失，第一次 provider 调用直接 `ECONNREFUSED`，整轮就此结束、回复为空。同一份日志里还有一次 `[reviewer:correction] … failed { reason: 'session-busy', error: 'An ACP prompt is already running for this session' }` —— 自动复盘想注入 [Auditor] 纠正时撞上「会话忙」，这条纠正被丢掉、检查项记为未处理。

建议：

1. reset 后不要立刻接受新 prompt——等新 runtime 就绪再放行（现在 `prompt start` 与进程替换是并行的）；
2. 首次 provider 调用遇到 `ECONNREFUSED` / `ECONNRESET` 时自动重连重试，而不是把整轮判失败；
3. `session-busy` 的复盘纠正应排队重试，不要直接丢弃。

## 十六、会话卡死：根因与修复（已实机验证）

### 症状

死在中途的一轮结束后，该会话**永久拒发**：每次 `sendPrompt` 都回
`An ACP prompt is already running for this session`，而会话状态是 `error`、一条回复都没有。实测会话 `ac913c29` 连续两次被拒，重启应用前没有任何自救手段。

### 根因

轮次死在 provider 断链（`ECONNREFUSED 127.0.0.1:53902` / `ECONNRESET`）时，它占用的 prompt 交互**没有 settle**；`assertSessionIdle`（`prompt-turn-workflow.ts:464`）只看 `interactions.current(sessionId)` 是否存在，不看那一轮是否还活着，于是把整条会话封死。手动调 `acp.cancel` 后同一句发送立刻成功、回复 123 字——证明是残留而非真在跑。

### 修复

交互不可能比拥有它的进程活得久，所以在会话被替换（`resetSessionContext`、`switchSpecialist` 且 `contextReset:true`）之后立即释放：
`src/main/acp/runtime.ts` 新增 `releaseInteractionsLeftBehindByReplacedSession`。
另在渲染层加了窄口恢复（`lib/acp/stale-turn-recovery.ts`）：仅当错误是「already running」**且** store 显示该会话不在 `running` 时，`cancel` 后重发一次，避免连点两次发送把用户刚起的轮次取消。

### 实机验证（两次，构建含三处修复）

**第一次（会话 `f1748d0f`）**

```
bind clinical-study-designer → {"contextReset":true}
send-1 ok → user:21 / agent:460   「两臂平行对照试验（骨架…）」
send-2 ok → user:17 / agent:139   「无法给出具体例数…」
会话最终 status=idle，无 already-running、无 error
```

**第二次（会话 `5c0846c2`，含代理端口修复的构建）**：`bind → contextReset:true`；`send-1 ok` → `n=6 roles=uaaaua`；`send-2 ok` → `n=8 roles=uaaauaua`，两次都 `status=idle`、无 `already-running`、无 `error`。回复分别 511 字与 142+144 字，纠正轮 [Auditor] 也正常注入。

**同一条曾经必死的路径（绑专才后连发两次）现在连续两次运行都跑出回复。** 注意：这次日志里仍有 6 条 `ECONNREFUSED`，来自 reviewer MCP server 拆除时 agent 的延迟重拨（`reviewer-session-owner.ts:230` 已记录这一族），**说明该错误行本身不等于会把轮次打死**。

## 十七、`[Auditor]` 撞 session-busy 丢纠正：试过重试，撤回

现场的失败长这样（`/tmp/ps-app17.log`）：

```
[reviewer:correction] injecting [Auditor] message into main session { sessionId: 'ac913c29-…' }
[reviewer:correction] [Auditor] correction sendPrompt failed {
  reason: 'session-busy', error: 'An ACP prompt is already running for this session' }
[reviewer:orchestrator] correction failed in fix loop — marking remaining checks unaddressed
```

我按「等一会儿再发一次」改了一版：`session-busy` 且有余额时等 5s 重试一次，并加了两个用例（busy 一次后成功、始终 busy 则不循环）。**改完 `correction.test.ts` 立刻翻红**——既有用例 `takes the slot when the running turn failed, so the session still gets a correction` 断言的是另一条语义：某条纠正道发送失败后应当**让出槽位**，让另一条道接管并发出去，最终只有一条纠正落库（`sent` 长度 1、接管那条的文本）。我的重试在等待期间仍握着单飞槽位，接管道只能一直 defer，于是「另一条道应发出」变成「被挡下」。

结论：**这条不能靠重试修**，`correction.ts:49-57` 的单飞设计说明写的就是这个意思（2026-11-09 两条评审道抢同一段纠正，不是瞬时故障）。已 `git checkout` 撤回，测试回到 15 passed。真正要动的是让评审在**主轮确实停止之后**再开始（现在 review 与 stop handler 有竞态），而不是让纠正在 busy 上碰运气。

## 十八、出网代理的端口漂移（`88578d18`）

`egress-proxy` 监听的是**临时端口**，而这个端口会被写进每个子进程的 `HTTP_PROXY`/`HTTPS_PROXY`。原先关闭出网时走 `proxy.stop()` 并把实例丢掉，再开启时 `start()` 绑一个**新端口**；已经在跑的 agent 仍拨旧端口 → 首次 provider 调用就是 `connect ECONNREFUSED 127.0.0.1:<旧端口>`，整轮报废。

改法：关闭出网时不再停监听，改为把允许列表置空（什么都不转发，策略等价），监听保留；进程退出仍走 `stop()`。

用例：关闭后仍能连上该端口、重新开启端口不变。**该用例在旧代码上失败、新代码通过**（`npx vitest run src/main/net/egress.test.ts` → 35 passed；stash 掉修复后 → 1 failed ）。

边界：我没有证据证明今天那几次 `ECONNREFUSED` 就是设置切换触发的，只能说这是端口漂移的一条确定路径，已堵。若还复现，下一步查 agent 进程 spawn 时 `applyEgressToChildEnv` 读到的端口与它实际拨的端口是否一致。

## 十九、评审与 stop 的竞态：纠正等主轮离开链路（`26fbc316`）

十七节里那条「不能靠重试修」的问题，正解就是排顺序：

- 评审在**轮次文本落库**时启动（`auto-review-trigger.ts` 找 `status === 'complete'` 的 agent 消息），而这一轮可能**还没离开链路**（定稿/产物仍在收尾）。此时注入纠正 → `An ACP prompt is already running for this session` → 检查项被标未处理。
- 修法：注入前先看 `getActivePromptSessions()`（与 `sendPrompt` 判忙读的是同一份 `sessionInteractions.snapshot()`），在链路上就每 200ms 轮询、上限 8s，离开后再发。轮询函数可注入。
- **为什么不是重试**：失败方在等待期间仍持有单飞槽位，重试会把接管道挡死——既有用例 `takes the slot when the running turn failed` 正是钉这个的，我上一版重试就栽在这。
- 一个细节：判断必须是**同步**的（`if (mainSessionIsOnTheWire(...)) await wait(...)` 而不是无条件 `await wait(...)`），否则即使无需等待也会让出发送时机，破坏「同一 tick 内发出去」的既有约定——这条也是被既有用例逼出来的。

用例：链路上先等待后发送（顺序 `['waited','sent']`）、空闲时不等待（`['sent']`）。reviewer **321 passed**、`typecheck:node` EXIT=0。

### 实机（会话 `b3039620`，构建含全部修复）

```
bind → {"contextReset":true}
send-1 ok → n=8  roles=uaaaaaua   agent 766 字
send-2 ok → n=12 roles=uaaaaauauaua  agent 364/165/413 字
[reviewer:correction] [Auditor] correction turn complete
status=idle，无 already-running、无 correction sendPrompt failed、无 releasing a prompt interaction
```

纠正这一轮正常落库，没有再撞忙；这次也没触发等待（纠正本来就在主轮结束后才到）。

## 二十、文献导入补 EndNote / MEDLINE（`c7e2d68c`，已实机）

缺口不是「没有 RIS」——RIS 与 Zotero JSON 早就通了。缺口是**界面允许选 `.enw` / `.nbib`，解析器却只认这两种之外的输入**，选进去只会得到一句「不是导出文件」。

补 `src/shared/citation/tagged-import.ts`：

| 方言            | 形态                               | 处理                                                                                      |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| EndNote `.enw`  | `%0 Journal Article` / `%T` / `%A` | 按 `%`+单字符切分；**值折行**要并回上一条（长标题、摘要常见）                             |
| MEDLINE `.nbib` | `PMID- ` / `TI  - ` / `AU  - `     | 标签 2–4 字符 + `- `；**续行是缩进的**——与 EndNote 相反，所以是两个解析器而不是一张标签表 |

两者输出与 `parseRis` 同构，共用 `planParsedImport`（去重、500 条上限、拒收原因只写一份）。

**标识符卫生**：MEDLINE 把出版商条目号写在同一批标签里（`LID - 88/4/401M [pii]`），早先会原样当 DOI 存进去，点开必然 404。现在只认 `10.` 开头的值，并且在 `LID`/`AID` 之间取第一个**真正是 DOI** 的（Rayyan 的示例里就有 `LID` 是 pii、`AID` 才是 DOI 的记录）。

### 真实文件（不是自造样本）

| 文件          | 来源                                                     | 结果                              |
| ------------- | -------------------------------------------------------- | --------------------------------- |
| `real.nbib`   | NCBI efetch `retmode=medline`（PMID 38123456、33567185） | 2 条，0 拒收，DOI/PMID/卷期页全中 |
| `real.ris`    | Crossref content negotiation（10.1056/NEJMoa2034577）    | 1 条，0 拒收，作者 29 人          |
| `real.enw`    | Rayyan 官方示例 `endnote-example.enw`                    | 3 条，0 拒收                      |
| `rayyan.nbib` | Rayyan 官方示例 `new-pubmed-example.nbib`                | 10 条，0 拒收                     |

### 实机（走界面的文件选择，不是直接调函数）

```
文献库 → 导入文献（Zotero JSON / RIS / EndNote / MEDLINE）
before: rows 0
选 real.enw → references.list() = 3 条
  Identification of Skin as a Major Site on Pr… / ELECTROCARDIOGRAM ABNORMALITY… / Isolation and identification…
选 real.nbib → references.list() = 5 条，PMID 33567185、38123456 已入库
```

三次测试用例：`tagged-import` 10 例、`ris-import-plan` 10 例（含 EndNote/MEDLINE 计划级与 DOI 去重）、i18n 62 例、references 组件 78 例；`typecheck:web` EXIT=0。

## 二十一、文献检索对外的 MCP 服务器（1.1，已用外部客户端验过）

### 为什么是「重写」而不是「转发」

仓内 `src/main/connectors/descriptors/{pubmed,arxiv,literature-review}.ts` 早就把检索定义成 MCP 工具，但它们跑在 **agent 进程**里，且用 `DOMParser` 解析 XML（`descriptors/pubmed.ts:61`）——主进程 Node 没有这个 API。外部客户端（Claude Desktop、Cursor、脚本）既够不着 agent 进程，也不该要求桌面端开着。于是按「主进程侧 DOM-free 实现」这条路走。

### 交付

| 文件                                         | 作用                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/main/literature/xml-fields.ts`          | 无 DOM 的标签读取（命名空间无关、实体解码）                                                                  |
| `src/main/literature/search.ts`              | PubMed（esearch + esummary + efetch XML）、arXiv（Atom）、Crossref（REST），统一记录与去重，`formatCitation` |
| `src/main/literature/mcp-server.ts`          | 三个工具 + stdio 传输；`--purescience-literature-mcp` 进入该模式                                             |
| `scripts/verify/literature-mcp-external.mjs` | 一个真正的外部客户端：spawn → tools/list → 三个工具各调一次                                                  |
| `docs/guides/literature-mcp.md`              | 启动方式、Claude Desktop 配置、边界                                                                          |

### 两个只有真跑才暴露的缺陷（都已修）

1. **摘要一条都没拿到**：先用 `efetch rettype=abstract&retmode=text`，那是**排版给人看的**——正文前面是引文块，摘要是不带任何标签的段落，没有可依据的字段标记。实测 6 条全部 `Metadata only`。改读 `retmode=xml` 的 `<AbstractText Label="METHODS">`，既找得到，也保留了章节标签。
2. **arXiv 单篇查询 400**：用 `search_query=all:id:2103.14030` 去查 id 是错的，端点要 `id_list=`。改 `lookupArxivId`。

另外：工具失败的返回从「抛异常」改成 `{error:'call-failed', detail}`，`literature_cite` 也区分「标识符不认识」与「索引挂了」——否则网络故障会被报成「你的标识符有问题」。

### 实机读数（外部客户端，真实接口）

```
tools/list → literature_search / literature_get / literature_cite
literature_search("semaglutide obesity", limit 3)
  → count 6, errors [], 5 条 read=Abstract（摘要 1536/1706/… 字），1 条 Metadata only
literature_cite("10.1056/NEJMoa2034577")
  → "Fernando P. Polack, Stephen J. Thomas, Nicholas Kitchin, et al. Safety and Efficacy of the BNT162b2 mRNA
     Covid-19 Vaccine. New England Journal of Medicine. 2020. 383(27). 2603-2615. doi:10.1056/nejmoa2034577."
  → location {read: Metadata only, url: https://doi.org/…, source: crossref}
literature_get("2103.14030")
  → Swin Transformer: Hierarchical Vision Transformer using Shifted Windows
    Ze Liu / Yutong Lin / Yue Cao … 2021, arxivId 2103.14030v2, read=Abstract
```

脚本退出码 0。测试：`src/main/literature` **16 passed**（含经 in-memory transport 走真实 MCP 线的 5 例），`typecheck:node` EXIT=0，ESLint 0。

## 二十二、本机文献库对外可用（1.2，实机闭环已完成）

1.2 不是从零起一个服务器：`purescience mcp` 这条桥早就在，surface 里有 5 个工具（4 读 1 写）。缺的是库。

### 交付

| 位置                                          | 改动                                                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/external-mcp/surface.ts`            | 5 个工具：`search_library` / `get_reference`（读），`add_reference` / `set_reference_notes` / `remove_reference`（写）；`referenceRow` 与 `filterReferenceRows` 投影 |
| `src/main/external-mcp/server.ts`             | 读处理器与三个写计划；写集合由 1 个变 4 个；`resolveProjectRow` 读写共用；`resolveWriteSession` 校验会话属于该项目                                                   |
| `src/main/application-command-composition.ts` | `EXTERNAL_MCP_COMMAND_COUNT` 5 → 9（`references:list / add / set-notes / remove`）                                                                                   |
| `docs/guides/library-mcp.md`                  | 工具表、`sessionId` 的理由、行为约定、无窗口审批方式                                                                                                                 |
| `scripts/verify/library-mcp-external.mjs`     | 外部客户端闭环脚本                                                                                                                                                   |

### 设计上被实机逼出来的一件事：写工具必须带 `sessionId`

第一版把库写入的会话设为 `undefined`，实机调用直接返回 `approval-unavailable`——**审批卡只能停在会话里**，没有会话就无处显示，工具等于空壳。改成必填 `sessionId` 并在上卡之前校验（`session-not-found` / `session-not-in-project`），拒绝发生在人被打扰之前。这条是「禁空壳」的直接体现：宁可要求参数，也不留一个永远批不下来的写接口。

### 协议层证据（真 MCP 线，不是直接调函数）

`src/main/external-mcp` **37 passed**，新增库用例覆盖：

- 中文未分词子串检索（「医学影像」命中标题）；
- `limit` 命中上限时 `total` / `returned` / `truncated` 三者自洽；
- 空 `query` 被拒（不当「查全部」）；
- 按 id 与按 DOI 各读一次，缺失字段不臆造（无 DOI 的记录 `doi` 为 `undefined`）；
- 加记录：审批通过后才写、卡上显示解析后的记录、卡停在该会话、重复 DOI 在上卡前拒；
- `[pii]` 冒充 DOI → `invalid-argument`；
- `no-change` 拒、删除卡上写标题、无会话/跨项目会话/不存在会话三种拒绝且什么都没写；
- 卡不可用 → `approval-unavailable` 且库不变。

`typecheck:node` EXIT=0，ESLint 0，`pre-push-checks` 全绿。

### 实机（隔离实例 `/tmp/ps-verify23-config`，不碰真实库）

外部客户端 `scripts/verify/library-mcp-external.mjs` 走的是 `purescience mcp` 这条真桥，审批由脚本在另一个进程用 `purescience permissions` + `approve` 回答。一次完整闭环：

```
search_library(空库)            total 0
add_reference(过卡)             added cmwmee0sp0001jtdi4r9w2d52  citationKey Ref2024
                                卡面: An outside MCP client asks to add “深度学习在医学影像中的应用与挑战” to project “MCP 验证”
search_library("医学影像")      total 1  id cmwmee0sp0001jtdi4r9w2d52  作者 [张三, 李四]  hasPdf false
get_reference(按 DOI)           命中同一条，notes「外部 MCP 客户端写入」
set_reference_notes(过卡)       notes「方法学参考（已由外部客户端更新）」
remove_reference(过卡)          removed true
search_library(删除后)          total 0
```

守卫实机读数（同一条真桥）：

| 动作                      | 返回                                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| `query: ""`               | `invalid-argument`：`query` must be a non-empty string                  |
| DOI 传 `88/4/401M [pii]`  | `invalid-argument`：不是 DOI，DOI 以 `10.` 开头                         |
| 会话 id 不存在 / 属别的根 | `session-not-found`                                                     |
| 同 DOI 再加一次           | `duplicate-reference`，且**审批队列前后都是 0**——无变化的写不会去打扰人 |
| 删掉后再查                | `total 0`                                                               |

`session-not-in-project` 只有单测覆盖（隔离根里只有一个项目，造不出跨项目会话），如实标注。

### 实机暴露的两个缺陷（都已修，都有回归）

1. **跑的是旧包，把 `sessionId` 那道门当成没用**：改完必填 `sessionId` 后没重新 `electron-vite build`，隔离实例加载的仍是 `out/` 里的旧主进程。现象是明明传了会话仍 2ms 返回 `approval-unavailable`，日志里也没有 `external mcp approval unavailable` 警告——因为 `!input.sessionId` 这一支直接返回，根本没进 try。教训：验收实例必须重新构建，否则验的是上一版。
2. **`references:add` 返回的是判决不是记录**：真实命令返回 `{ status: 'created' | 'duplicate', reference }`，而写计划把它当记录读，于是 `add_reference` 回了一个**没有 id 的载荷**（`{"projectId":…,"reference":{"authors":[],"hasPdf":false}}`）——记录其实写进去了，客户端却拿不到 id，接着删也删不掉（`referenceId` 是 undefined）。修：读 `status`，`created` 才取 `reference`，`duplicate` 回 `duplicate-reference`；单测的 fake router 也改成照真实形状答 `{ status, reference }`，并新增一例钉住「命令说 duplicate ≠ 写入成功」。这个缺陷只有真跑才暴露——之前 37 例全绿，因为 fake 把返回值编成了裸记录。

## 二十三、外部客户端生成演示文稿（1.3）

`--purescience-pptx-mcp` 是一个独立 stdio 服务器，不依赖桌面端：写 deck 是纯函数（`src/main/slides/pptx-deck.ts` 早就在，字节只由大纲决定），所以 1.3 做的是把它接到外部客户端手里，而不是重写一个写盘器。

### 交付

| 位置                                                | 改动                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/slides/mcp-server.ts`                     | `pptx_create`（写）与 `pptx_read`（读回）；绝对路径 / `.pptx` / 上限三种前置校验；拒绝以 `{ ok: false, refusal }` 返回而不是抛异常 |
| `src/main/mcp-server-args.ts` / `src/main/index.ts` | `PPTX_MCP_SERVER_ARG = '--purescience-pptx-mcp'`，懒加载分支                                                                       |
| `docs/guides/pptx-mcp.md`                           | 工具表、接入片段、上限、刻意不做的事                                                                                               |
| `scripts/verify/pptx-mcp-external.mjs`              | 真子进程外部客户端 + 两个第三方阅读器                                                                                              |

### 协议层证据

`src/main/slides` **18 passed**（其中 4 例是新的协议层用例，走 `InMemoryTransport` + 真 MCP `Client`）：中文三页 deck 建到嵌套目录并被读回、`unzip -l` 能看到 `ppt/presentation.xml` 与 `ppt/slides/slide3.xml`、同一大纲两次产出**字节完全相同**而改一条要点就不同、相对路径 / `.key` / 空 sections 三种拒绝、缺文件与非 zip 两种读回拒绝。`typecheck:node` EXIT=0。

### 实机读数（外部客户端，`/tmp/pptx-verify`）

```
tools/list          ["pptx_create", "pptx_read"]
pptx_create         ok true  path /tmp/pptx-verify/nested/deepseek-eval-deck.pptx  bytes 8870  slideCount 4
磁盘比对             8870 字节，与返回值一致（父目录 nested/ 自动创建）
pptx_read           ok true  slideCount 4；封面标题「国产大模型评测方法论」，副标题一行；三个内容页要点逐条读回
macOS Quick Look    producedThumbnail true，缩略图 22,444 字节
app 渲染器 parseZip  slides 4 / layouts 1 / masters 1
```

Quick Look 的缩略图人工看过：黑色大标题「国产大模型评测方法论」、下方一行「外部MCP客户端生成」，灰底居中，**中文无乱码、无空白页**——这是系统级阅读器，不是我们自己的代码在自证。

### 一处只有真跑才看得见的坑

`qlmanage` 在输出目录不存在时**照样返回成功、什么都不写**，第一次因此把「能预览」误读成「不能预览」；修法是在调用前 `mkdir -p`，并把「产出缩略图」而不是「退出码 0」作为判据。

## 二十四、外部客户端看进度与定时任务（1.4）

两个只读工具，都复用已有命令（`sessions:list-catalog`、`routine:list-all`），**没有新开 IPC 通道**——白名单 9→10。

### 实机读数（隔离实例）

```
mcp --list-tools              12 个工具，含 session_activity / list_schedules
启动清单认证                   无 "expected N external MCP commands" 报错
/rpc/routine:upsert           建成真定时任务（每 30 分钟，"活动验收定时任务"）
list_schedules                total 1  enabled 1  paused 0  everyMinutes 30  nextDue 有值  tickCount 0
session_activity 跑前          total 1  running 0  status idle  messages 11
session_activity 跑中/跑后     status idle → error → idle，messages 11 → 13
```

### 一条没能实机证明的事（如实写）

**`running` 这一刻没观察到**。隔离根没有可用模型凭证（dev 构建拿不到钥匙串密钥），run 在建连阶段就落 `error`，所以客户端只看到 `idle → error → idle`。我试过把会话文档里的 `status` 改成 `running` 再读，工具仍返回 `error`——说明 catalog 的状态来自 app 运行时判定，不是文件字段，这条路造不出来。判据里的「进行中」目前只有单测层面的映射证明：catalog 报 `running` → 工具上报 `running: 1`，且不混入别的项目的会话。

「完成」与「失败」两种状态是实机证明的，且工具不会把失败伪装成空闲。

### 顺带修掉的两个实现坑

- 工具表追加时 `rindex('])')` 命中了 `reference.authors ?? []` 里的括号，两个新工具被塞进了 `referenceRow` 内部；表现是 `unknown-tool` 和 `TS1005`。教训：往冻结数组里加条目要锚定唯一注释，不能锚定括号。
- 测试里 catalog fixture 是模块常量，`status: catalogBusy ? …` 在加载时就被烤死，永远看不到 `running`；改为 router 每次调用时套用标志。

## 二十五、仍未做的

- **10 位专才未跑任务**（12 位中已验收 2 位：`tcm-evidence-expert`、`radiology-imaging-expert`）。
- 切换专才导致的 contextReset 仍会打断进行中的那一轮（提示已改成事实描述，但没有阻止打断本身）；agent 运行中调 `setSessionSpecialist` 会报 `Cannot switch specialist while the Agent is running.`，界面在下拉里点选不会遇到，但调用方需要等空闲。
