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

## 六、仍未做的

- 其余 11 位专家未逐个跑任务（同一代码路径，装了但未逐个验收）。
- 安装成功后**没有提示「去启用」**，用户必须自己发现「继续设置」；本轮就是踩了这个坑才找到流程。
- 「Session was interrupted before the app closed.」这句在应用未关闭时也出现（由切换专才的 contextReset 触发），文案误导。
