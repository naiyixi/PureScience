# 证据：「方法即产物」甲半 —— 把已记录的方法编译成可调用能力（2026-10-15）

单元归属：v2.3.0 批 E 的**甲半**（排期档 `docs/plan-2026-10-10-v2-line-schedule.md` 里「画布 → 编译为可调用能力」）。
实现的第一步（纯编译层 / 来源层 / 编排层）由会话在 `e2a7f4bb`、`ea4df7ca` 补进跟踪集；本笔把**接线收口**：
RPC 分支、MCP 工具面、stdio 传输的分流，并顺手修掉 main 上仍在的红。

## 一 这一笔改了什么（文件级）

| 文件 | 内容 |
| --- | --- |
| `src/main/notebook/local-rpc-server.ts` | `skillCreate` 新增 `skillMethodCompiler` 选项与 `fromRunId` 分支：带 `from_run_id` 时由应用**自己的记录**编译（不读调用方给的正文），同时具名拒绝 `instructions`/`kind`/`evidence` 任一并存（两个真源会被静默取一个） |
| `src/main/skills/mcp-server.ts` | ① `createSkill` 的返回类型张开为「草稿 ∪ 编译结果」；② 工具 schema 新增 `from_run_id`（snake→camel **显式**映射，不为改名静默丢掉）；③ `instructions` 改为**可选**（否则模型被迫送出一份它不允许送的正文）并在处理器里强制「二选一」；④ 新增 `createLocalSkillCreator`：stdio 传输**按每一种形态需要什么**分流 —— 草稿仍就地写（与改动前逐字一致），编译走应用 RPC（运行记录只在主进程里） |
| `src/shared/skill-create.ts` | 工具描述/系统提示各一句（agent 面向，英文）；`fromRunId` 字段与 `fingerprint`/`sourceRunId` 结果字段；schema 里 `instructions` 的说明改为「除非给了 `from_run_id`」 |
| `src/main/skills/mcp-server.test.ts` | 新增 3 条：工具面 `from_run_id` → 编译形态；双源 ⇒ 具名拒答；两者都没有 ⇒ 具名拒答；另有 2 条对 `createLocalSkillCreator` 的分流（草稿真落盘 / 编译走 RPC 且**不碰**技能目录） |
| `src/main/notebook/local-rpc-server.skill-import.test.ts` | 新增 1 条：RPC 层别名解析 + 编译分派 + 冲突拒答 + 未配置拒答 |
| `src/main/notebook/local-rpc-server.skill-create-from-run.test.ts` | **新增**：服务层端到端（见第三节） |

## 二 契约 / 单元层读数

`npx vitest run src/main/skills/mcp-server.test.ts src/main/skills/method-skill.test.ts src/main/skills/method-skill-compiler.test.ts src/main/notebook/local-rpc-server.skill-import.test.ts src/main/notebook/local-rpc-server.skill-create-from-run.test.ts`
⇒ **5 文件 / 73 passed**（编译器 8 + 编排 6 + 工具面与分流 5 + RPC 层 6 + 服务层端到端 2，其余为既有用例）。

## 三 服务层「实机」读数（不起 Electron）

`src/main/notebook/local-rpc-server.skill-create-from-run.test.ts` 把每一环都换成产品自己的实现，只有数据根与配置根是 `/tmp` 隔离目录：

- **真通道**：`NotebookLocalRpcServer` 的真 TCP 监听 + 真 token（`issueSkillImportConnection`），POST `skillCreate`；
- **真数据**：运行记录由**应用自己的仓储**写出（`NotebookRunRepository.loadOrCreate` + `appendRun`），不手搓 `run.json`（手搓会绕过路径编码与归一化，「来源层读得懂真实记录」就没被验到）；
- **真结果**：`/tmp` 配置根下的 `skills/<名>/SKILL.md` 读回来断言 —— 正文含那条记录里的脚本文本、`trust_origin: "run-7"`、指纹；并且**只**写出一份文档（`readdir` 两处计数）。
- **拒答路径**：`from_run_id` 指向不存在的运行 ⇒ `state: 'refused' / reason: 'not-found'` 且**一个文件都没写**（`readdir` 得 ENOENT）。

## 四 真机记录读数（本机真实数据，**只读**复制到 /tmp）

素材：本机 `~/.purescience/notebooks/<项目 id>/<会话 id>/run.json` —— 该目录 81 份记录里 **2489 条**「已完成且有正文」的运行；取其一（`notebook-run-1787322066868-190`，678 字节正文）只读复制到 `/tmp/ps-probe-runs`，用产品自己的仓储 + 编译器编译，再读回盘上的文档。

```
PROBE outcome   {"state":"created","fingerprint":"method-skill:v1-290de047…77caac","kind":"procedure",
                 "projectId":"cmt31dz5c0005wfeiv2aqqmsv","runId":"notebook-run-1787322066868-190"}
PROBE document  {"documentBytes":2192,"scriptBytes":678,"skillsWritten":1}
PROBE second compile {"fingerprintStable":true}
```

⇒ 三件事被真数据验到：① 来源层读得懂**这台机器上应用自己写过**的记录（不是只读得懂夹具）；② 文档正文包含那条记录里的脚本**逐字**（断言 `toContain(record.script.trim())`）；③ 同一条记录 + 同一个名字两次编译指纹一致。

**探针纪律**：一次性 spec 用完按精确名删除 ✓（`src/main/notebook/zz-realmachine-probe.test.ts` 已删，全量跑未收录它 —— 日志里零命中）；`/tmp/ps-probe-runs`、`/tmp/ps-probe-skills` 收尾删除 ✓；真实数据根**只读**，一个字节都没写 ✓。

## 五 变异证明（断言没被削弱）

| 变异 | 读数 |
| --- | --- |
| RPC 分支把 `runId: fromRunId` 改成 `String(params.name)` | 服务层 2 条**当场红**（一条 `expected { state: 'refused' } to match { state: 'created' }`，一条拒答详情里没有那个 run id） |
| 编排层删掉 `provenance: draft.provenance` | 服务层 + 编排层共 2 条**当场红**（`trust_origin: "run-7"` 不在文档里） |

两次变异都已回退，六个文件的 md5 与变异前**逐字相同** ✓。

## 六 顺手修掉 main 上的红（独立确认）

- 隔离工作树（`git worktree add --detach /tmp/ps-verify-head HEAD` + 软链 `node_modules`）里跑 `tsc -p tsconfig.node.json --composite false` ⇒ **1 条错**：`src/main/ipc.ts(1950,7): error TS2353: … 'skillMethodCompiler' does not exist in type 'NotebookLocalRpcServerOptions'`；
- 独立对照：`Nightly @ea4df7ca` 的作业 `build / Verify (lint + typecheck + test + package)` = **failure**，日志原文就是这一条（`##[error]src/main/ipc.ts(1950,7): error TS2353 …`）；同一提交的 `Windows Full Test` = success（步骤集不同，看不到它）。
- 成因：组合根那两行（`import` + `skillMethodCompiler:`）已在 `9f0136d2` 提交，而**声明它的**选项在 `local-rpc-server.ts` 里一直只在工作区 ⇒ 只有全量类型检查能看见。
- 本笔提交后该选项进入跟踪集 ⇒ 工作树上双 typecheck 各 **0 条 error**。

## 七 未取证（具名，不冒充）

| 面 | 为什么没取 | 落点 |
| --- | --- | --- |
| **真窗口点击读数**（在会话里让 agent 用 `from_run_id` 存一条技能、看屏上结果） | 内存闸门关着：空闲页 **4097 ≈ 64 MB**、swap **8555M / 10240M** ⇒ 按仓规不起 `build:e2e` + Electron | 归会话在隔离实例里取（`PURESCIENCE_STORAGE_ROOT` + `settings.dataRoot` 同时指向隔离根） |
| **真实 agent 回合**（模型真的调 `create_skill{from_run_id}`） | 同上；且成功路径会把技能写进配置根，真实配置根只读 | 同上，用隔离实例 |
| 窗口态的「已存技能」列表是否显示指纹/来源 | 该面属另一单元（技能库展示），本笔未动渲染层 | 不声称 |

## 八 门禁读数（本笔）

| 门 | 读数 |
| --- | --- |
| `npx eslint --no-cache .`（全仓） | **0 error / 130 warning**（我碰过的 6 个文件 scoped 复跑 **0 problem**） |
| `tsc -p tsconfig.node.json --composite false` | **0 error** |
| `tsc -p tsconfig.web.json --composite false` | **0 error** |
| 全量 `npx vitest run --maxWorkers=4` | 见提交信息（占位替换后的真实读数） |
| CI | 见队列档 §一百三十五 的双车道判决 |
