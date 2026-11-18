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

待查：中断/重置时把流式消息标为 complete 的那处代码（`useWorkspaceAgentRuntime` 的 abort 路径），正确行为应是存为 `error`/不完整，并在回放里标注截断。本轮未修，先记档。

## 十一、仍未做的

- **10 位专才未跑任务**（12 位中已验收 2 位：`tcm-evidence-expert`、`radiology-imaging-expert`）。
- 切换专才导致的 contextReset 仍会打断进行中的那一轮（提示已改成事实描述，但没有阻止打断本身）；agent 运行中调 `setSessionSpecialist` 会报 `Cannot switch specialist while the Agent is running.`，界面在下拉里点选不会遇到，但调用方需要等空闲。
