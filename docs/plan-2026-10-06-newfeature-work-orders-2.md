# 新功能工作单（三份）：RO-Crate 导入 · 技能导入版分叉 · 通知单条删除/清空

> 立案 2026-10-06（会话）。三项都由排期档「明确没做 / 新功能立项」段点名，**不在原行里假装已有**。状态：**待开工**。
> 共同前提：**i18n 九文件是共写冲突面**（队列档 §二十三）——插键前先 `git status --short | grep i18n`；与执行器同时改会互相裹带。
> 共同红线：**通道与真入口同批落地**（`renderer-contract-entry-coverage` 会拦），且新通道必触发五族 pin（目录 / 表面清单 / 本地 Web 计数 / 两个 Web 契约面 / 家族已装通道）⇒ 跑**全量**单测并 `npm run gen:web-api-map`。

---

## 一、RO-Crate：导入外来 crate（IC48 的另一半）

**现状（已核实）**：`validateRoCrate` 存在且用于**本应用写出的每一个** crate；外来 crate **没有入口** ⇒ 界面上已**明写**「Export only — an external crate cannot be imported or checked here yet.」（IC48 落地）。

**要做什么**：给外来 crate 一条**只读**的导入/校验入口 —— 选一个 crate（文件或目录），按**已有的** `validateRoCrate` 校验，把结果按 IC45 的体例呈现（**点名码在前、规则级明细与拒收清单在后**）。

**划界**：**不做**把外来 crate 合并进本项目、不做导入后改写它。校验通过也只是"能被本应用的规则读通"，**不等于**它科学上正确 —— 这句话要进文案。

**接缝**：`src/shared/ro-crate.ts`（校验与结果形状）、`src/main/ro-crate/ipc.ts`、`src/renderer/src/pages/workspace/RoCrateExportDialog.tsx`（IC45/IC48 已改过，文案与 `data-slot` 有先例）、`e2e/certification/ro-crate-export.spec.ts`（真机配方可抄：真导出一个 crate 当被验对象）。

**验收（真机）**：①用应用自己导出的 crate 当输入 ⇒ 校验通过（这条同时证明"外来"路径能读通自家产物）；②造一个**故意违规**的 crate（缺 MUST 项）⇒ 界面**点名**那条规则，并且**不**显示成"导入成功"；③把 IC48 那句「Export only」改成与事实相符的说法（入口在，只是只读）——**这句必须同批改**，否则界面自相矛盾。

---

## 二、技能：导入版分叉为个人技能（IC50 的另一半）

**✅ 已落地（自主执行器，2026-10-07；实现与门禁读数见队列档 `plan-2026-10-03-next-queue-and-round-convention.md` §二十五）。**
**仍未取**：收紧后的认证 spec `e2e/certification/skill-imported-copy.spec.ts` 的**真机读数**（内存不足，见 §二十五 末）。**唯一未落项**，下一轮内存宽松时第一条跑它。

**现状（已核实）**：`SkillDetailView` 对 `source === 'imported'` 的技能显示「Kept as imported: …no way to fork it into a skill of your own yet.」；**编辑加载器只服务 personal 技能**（其自身注释即如此写）。

**要做什么**：把"导入版"**分叉**成一份 personal 技能（新 id、来源记为 `forked-from:<原 id>`），此后按 personal 走既有编辑路径。

**划界**：分叉是**一次性复制**，不是"链回去"：原导入版**照旧按原样保留**（IC50 的承诺不变，那句话在分叉入口出现后要**改写**成"可复制一份为个人技能"而不是"没有办法"）。不做自动同步、不做覆盖导入版。

**接缝**：`src/renderer/src/pages/settings/SkillDetailView.tsx`（`data-slot="skill-imported-kept"`）、技能仓库（`UserSkillRepository`，落点在 `<存储根>/skills/<source>/<slug>/SKILL.md`；`sourceDir = join(storageRoot,'skills',source)`）、personal 技能编辑路径（IC50 已核实其存在）。

**验收（真机）**：①在导入版详情里触发分叉 ⇒ 磁盘上**真的**多出一份 personal 技能（读回目录，不看界面自陈）；②新技能能**编辑并保存**，且原导入版**字节不变**；③IC50 那句改写成与事实相符；④`SkillDetailView` 渲染套件与 IC50 的真机 spec（`skill-imported-copy.spec.ts`）都要跟着更新，**只许收紧**。

---

## 三、通知：单条删除 / 一键清空（IC47 的另一半）

**现状（已核实）**：`deleteSessions` / `markSessionsRead` / `reconcileSessionCatalog` **早已登记为内部清理**（`notification-inbox-runtime.ts:19-24` 把收件箱挂进会话删除协调器）⇒ 渲染层可见面（目录 `notifications` 组）只有 `getSnapshot / markAllRead / markRead / markSessionCompletionsRead / onChanged`。

**要做什么**：给用户**单条删除**与**一键清空**两个动作（面窄：只动收件箱记录，不动会话本身）。

**划界**：删除**通知** ≠ 删除**会话** —— 文案必须说清（否则用户以为删掉的是会话）。清空要有**二次确认**并说明不可撤销。

**接缝**：`src/main/notifications/*`（收件箱存储）、`src/shared/renderer-contract-catalog.ts` 的 `notifications` 组（新通道 ⇒ pin 级联）、面板组件（IC41/IC52 用过的 `data-slot` 与只读守卫体例）。

**验收（真机）**：①单条删除后**读回存储**确认该条真没了、其余还在；②一键清空后计数为 0 且**会话仍存在**（这条是划界的证据）；③取消二次确认 ⇒ 什么都不变；④`notification-session-clear.spec.ts`（IC41）的既有断言不得放松。

---

## 共同收尾清单（三项都适用）

- 通道与界面**同批**；新通道跑**全量**单测 + `npm run gen:web-api-map`
- 新文案 9 语（脚本自带九文件齐平 + 写后自证；**不得与英文逐字相同**）
- 证据落 `docs/evidence/`（三块式：真实事实 / 本轮观测值 / 本轮**没**证到什么）
- 排期档对应行与 CHANGELOG「明确没做」段**同步改正**（做过的不许留着"未做"）

## 读数回收（2026-10-07，会话；实施者=自主执行器，读数=会话）

三项由执行器落地后，**真机读数由会话补齐**（内存阻塞解除后：`build:e2e` 23–25 s 成功）：

| 项 | 提交 | 真机读数 | 备注 |
| --- | --- | --- | --- |
| ① 期刊别名解除 | `16fdafab` | ✅ `journal-alias-release.spec.ts` **1 passed (6.6s)**：存储回读 `aliases=[]`、刊表快照逐字相等（不越界）；确认句逐字读到两件事 | 证据档 `docs/evidence/2026-10-07-journal-alias-release.md` §五 |
| ③ 技能导入版分叉 | `42dd7855` | ✅ `skill-imported-copy.spec.ts` **1 passed (9.3s)**：原句已改写成"Duplicate it to get a skill of your own that you can edit."；副本**真落到磁盘** `skills/personal/seeded-import` | 读数是**目录回读**，不是界面自陈 |
| ④ 通知单条删除 / 一键清空 | `9bd516a1` | ✅ `notification-inbox-clear.spec.ts`（**本轮新写**）**1 passed (13.5s)**：警告句逐字读到「Your conversations are not deleted. It cannot be undone.」；单条删除后 **存储** `items=0`；空箱时面板说 "No messages yet." | **清空（clear-all）那半未真机验**：它需要**跨会话的多条通知**（通知按会话记，实测两条 prompt 只出一条），本读数不铺这个夹具 ⇒ 该半仍由单元 + 渲染套件承担，**具名**不冒充 |

**一条夹具事实（本轮实测，值得留档）**：通知是**按会话**记的 ⇒ 同一会话里连发两条 prompt 仍只有一条 `task.completed`；要两条就得两个会话，而 `createProject` 在会话工作区内点不到 "New project"（需先回首页）。
