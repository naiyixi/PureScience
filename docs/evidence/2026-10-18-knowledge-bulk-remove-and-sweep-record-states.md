# 知识库面板：多选批量移除 + 清扫记录三态（2026-10-18）

提交：`855c20ed`（`feat(knowledge): 多选批量移除来源 —— 逐条走同一通道，拒绝的那条留在原位`）
基线：`722471fa`（v2.12.0），rebase 到 `c99d2e32`（v2.13.0）

## 一、为什么做这一件

v2.12.0 的排期把三件事写进了同一版（「上次清扫」读数 + 批量移除 + 分页），发布时实际只有前两件，
CHANGELOG 的自陈里也明写「**批量移除仍未做**（一行一个移除按钮，多选与批量确认要做一遍契约与文案）」。
所以这是排期内的欠项，不是自选尾巴。

同批收掉一处**诚实性缺口**：清扫记录原来只有「有 / 没有」两态——一份在盘上但读不出来的记录，被折成
「没有记录」。缺文件是事实（没有清扫过），坏文件是「我们说不上来」，两者在屏幕上不能同形。

## 二、批量移除怎么做的（零新通道）

一条批量移除 = **N 次既有的单行移除**（`knowledge:remove-source`），所以这条路上早就验过的语义原样成立：
副本按引用淘汰（另一条来源仍名字节的副本会被保留）、拒绝理由逐字上屏。没有新增通道、没有新增契约项，
preload / 目录 / 计数一个字节没动。

交互闭环：

| 步骤 | 行为 | 为什么 |
| --- | --- | --- |
| 勾选 | 每行一个复选框；页头「全选本页」只作用于**当前页看得见的行** | 勾选别的页上没人看过的行再删，等于替读者决定他没看过的事 |
| 上膛 | 第一次点击只把按钮换成「确认移除 N 个来源」+ 取消 | 批量删是这个面板里唯一一个「看屏幕撤回不了」的动作 |
| 执行 | 逐条调用、逐条记账；成功数与随之清理的副本数相加后如实报出 | 不把部分成功说成一次干净的清空 |
| 失败 | 被拒的那一条**仍在列表里、仍然勾着**，句子点名它和拒绝码 | 可以直接对那一条重试 |
| 收尾 | 重新读一遍来源清单（不假设结果），并把已不存在的勾选丢掉 | 上膛的集合里不能留着没有对应行的 id |

## 三、清扫记录三态

`KnowledgeOverview` 新增 `lastSweepUnreadable?: boolean`（可选，不改既有消费者）：

- 文件不存在 ⇒ `lastSweep` 缺席、`lastSweepUnreadable` 缺席 ⇒ 面板**不说**（事实是「还没清扫过」）；
- 文件可读且形状合格 ⇒ `lastSweep` 带时间与五个计数 ⇒ 面板报「上次清扫 …」；
- 文件在盘上但读不出 / 解析失败 / 形状不合格 ⇒ `lastSweepUnreadable: true` ⇒ 面板明说
  「上次清扫的记账读不出来——这和「从未清扫过」是两回事。」

读文件本身的失败也分了态：只有 `ENOENT` 算「没有记录」，其余（权限、IO）算「读不出来」。

## 四、读数（都实跑，非推断）

| 门 | 命令 | 读数 |
| --- | --- | --- |
| 定向单测 | `npx vitest run src/main/knowledge src/renderer/src/pages/settings src/renderer/src/i18n` | **82 文件 / 816 passed / 1 skipped** |
| 类型（web） | `npx tsc --noEmit -p tsconfig.web.json --composite false` | 0 错 |
| 类型（node） | `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit -p tsconfig.node.json --composite false` | 0 错 |
| 改动面 lint | `npx eslint --no-cache <改动路径>` | 0 |
| 真机（批量移除） | `npx playwright test e2e/certification/knowledge-bulk-remove.spec.ts`（先 `npm run build:e2e`） | **1 passed (4.2s)** |
| 真机（清扫记录三态） | `npx playwright test e2e/certification/knowledge-copy-sweep.spec.ts` | **1 passed (2.8s)** |

真机读数里的证据不是面板自己的句子：

- `knowledge-bulk-remove.spec.ts` 注册三个**真实文件**（写在数据根内），勾两条 → 屏上读到 `Selected 2` →
  确认 → 屏上 `Removed 2 source(s); 0 stored copy(ies) pruned.`；随后**测试进程自己读**
  `<数据根>/knowledge/sources.json`：只剩未勾的那一条（`location` 逐字符比对），且三个探针文件都还在盘上
  —— 注销来源不是删读者的文件。上膛那一步另有断言：确认前登记簿仍是 3 条。
- `knowledge-copy-sweep.spec.ts` 追加：清扫后刷新能看到记录行；把 `last-sweep.json` 写成坏 JSON 再刷新 ⇒
  记录行消失、读不出来那句出现（两个断言方向都在，不是「没显示就算过」）。

## 五、明确没做（不改口径）

- 分页仍是**客户端**分页：`listSources` 一次返回全部来源（来源上千时需要服务端分页）。
- 批量移除只跨**当前页的勾选**，没有「选中全部 N 条」。
- 清扫读数**不保留历史**，只留最近一次。
