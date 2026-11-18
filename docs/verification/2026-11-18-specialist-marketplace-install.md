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

## 十六、仍未做的

- **10 位专才未跑任务**（12 位中已验收 2 位：`tcm-evidence-expert`、`radiology-imaging-expert`）。
- 切换专才导致的 contextReset 仍会打断进行中的那一轮（提示已改成事实描述，但没有阻止打断本身）；agent 运行中调 `setSessionSpecialist` 会报 `Cannot switch specialist while the Agent is running.`，界面在下拉里点选不会遇到，但调用方需要等空闲。
