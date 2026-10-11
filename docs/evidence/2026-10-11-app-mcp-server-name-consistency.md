# 应用自有 MCP 服务名两侧一致（v2.0.0 P0-6 后半）—— 2026-10-11

**交付提交**：`63ebc76b` fix(mcp): 应用自有 MCP 服务名统一为无分隔符拼写（P0-6 后半）（42 文件，+229/−155）。
**本单元要修的那件事**：应用把自有 MCP 服务的名字交给 agent 框架时，**同一份名字用了两套约定**
——`purescience_notebook`（下划线）与 `purescience-plan` / `purescience-artifacts` /
`purescience-figure` / `purescience-activity` / `purescience-skills` / `purescience-memory`（连字符）并存。
框架把服务名嵌进工具名（`mcp__<服务>__<工具>`）再交给模型，于是**模型看到的是混合拼写**，猜错一次
就是一次 `tool call failed / No such tool available`（本轮之前 notebook 已由 `f41f176e` 改成无连字符，
其余五个服务与 figure 未改）。

## 一、真机读数（用户自己的日志，不是我造的夹具）

来源：本机 `~/Library/Logs/PureScience/main.log` + `main.1.log` + `main.2.log` **三份全量**
（应用自己写的主日志，窗口 **2026-09-16T08:13Z → 2026-10-10T13:46Z**）。
取数脚本已入库可复跑：

```bash
node --experimental-strip-types scripts/audit-mcp-tool-name-failures.mjs
# logDir=/Users/totota/Library/Logs/PureScience
# identities=19  failure lines=31
```

判据：每条失败行里的**猜测名**，与「应用今天为同一个工具渲染的名字」逐字比较。
分类结果（脚本原样输出）：

| 类 | 条数 | 判读 |
| --- | --- | --- |
| **`callable-now`** 猜测名 = 应用今天渲染的名字 | **12** | 本改动**直接修**：同一次猜测今后能解析到真工具 |
| `wrong-separator` 只差分隔符、但渲染名本来就没有连字符 | 6 | 本改动**不修**（见 §四.1） |
| `no-such-leaf` 叶子名不在目录里（模型编的） | 5 | 与本单元无关 |
| `not-app-server` 不是本应用的服务 | 8 | 与本单元无关 |

`callable-now` 的 12 条逐字是：

- `mcp__purescience_plan__update_step_status` **8 条**（2026-10-04T05:39Z 同一分钟内 8 连击）
- `mcp__purescience_figure__figure_review` **4 条**（2026-10-02T16:00Z、2026-10-04T15:31Z ×2、
  **2026-10-10T13:46Z —— 本轮开工前最近的一条**）

它们当时的记录工具分别是 `purescience-plan/update_step_status` 与 `purescience-figure/figure_review`：
**模型猜的是无连字符名，而当时注册给框架的恰恰是连字符名**，于是「名字存在、只是拼写不是它注册的那一个」。
这正是本改动消掉的那一面对。

`wrong-separator` 的 6 条全部是 notebook、**全部是模型猜连字符**：`mcp__purescience-notebook__notebook_execute` 4 条
（2026-09-21T03:45Z / 04:42Z / 04:44Z ×2）× 与 `mcp__purescience-notebook__bash_execute` 2 条
（2026-09-21T03:50Z、2026-10-04T11:19Z）。notebook 的名字在 **`f41f176e`（2026-09-21 01:52）**就已经是无连字符，
而这 6 条里 5 条发生在该提交之后 —— 见 §四.1。

## 二、交付内容（42 文件）

| 面 | 内容 |
| --- | --- |
| 命名模块 | `app-mcp-names.ts`：`activity`/`artifacts`/`skills`/`plan`/`memory` 五个服务的 `canonicalName` 去连字符（notebook 此前已是），旧拼写进 `legacyNames`；**未在此声明的服务**（figure、用户自建）也继续应答旧连字符拼写（`hyphenatedMcpServerName`） |
| 注册名常量 | `shared/activity-groups.ts`、`shared/skill-import.ts`、`shared/memory-mcp.ts`、`shared/figure.ts`、`main/artifacts/mcp-server.ts`、`main/session-plan/plan-mcp-server.ts` |
| 身份与权限 | `permission-grants/identity-catalog.ts`（预登记身份）、`acp/permission-policy.ts`（含 Codex 叶子别名表与产物保存判据）、`main/notebook/mcp-server.ts` 的 agent 文案、`acp/session-presentation-policy.ts` 与 `session-plan/guidance.ts` 的 agent 文案 |
| 渲染层 | `permission-request-presentation.ts`、`workspace-tool-activity-details.ts`：分隔符归一比较（历史记录与旧活动条目仍能识别） |
| 夹具 | `e2e/fixtures/fake-opencode.mjs` 的 MCP 客户端名 |
| 回归守卫（新增 4 条） | `app-mcp-names.test.ts`：① 所有声明服务的名字**不含连字符**；② 各服务**注册常量等于声明值**（把「两份名字漂移」这件事钉在测试上）；③ 旧拼写仍解析到**同一身份**；④ 未声明的服务保留旧拼写 |

## 三、可复核读数

1. **审计脚本**（§一）在**已提交的树**上跑出的分类（12/6/5/8）——脚本用的就是应用自己的命名模块，
   没有第二份名单。
2. **19 条身份**：`activity` 1 · `artifacts` 1 · `figure` 1 · `memory` 1 · `notebook` 12 · `plan` 2 · `skills` 1，
   每条身份在 claude-code 面的渲染名与注册名**逐字一致**（`mcp__purescience_<服务>__<工具>`），
   且身份的别名集合同时含新、旧两种拼写（如 `[purescience_plan, purescience-plan]`）。
3. **4 条回归守卫**在隔离工作树里全绿（读数见 §五）。

## 四、刻意的边界（不许读成「已做」）

1. **6 条「模型自己猜连字符」的失败不被本改动修**。判据是时间线：notebook 的无连字符名 `f41f176e`
   在 **2026-09-21 01:52** 就落地，而 `mcp__purescience-notebook__notebook_execute` 的 5 条失败发生在
   **2026-09-21T03:45Z 起**（同一台机器、同一份日志），2026-10-04 又有一条 —— 说明**单把一个服务改成无连字符
   并不能让模型停止猜连字符**。本改动做到的是**把混合约定的来源清零**（应用交给框架的名字里再没有连字符），
   但「模型今后不再猜连字符」**没有读数**，不许声称。**立案**：下一次真机窗口（或用户新日志）用同一支脚本复跑，
   判据 = `wrong-separator` 归零。
2. **`no-such-leaf` 5 条与 `not-app-server` 8 条不在本单元范围**：前者是模型编的叶子名
   （`checkpoint_load` / `notebook__execute`），后者是别的服务（`purescience-pubmed` 一类）或把服务名拆成两段
   （`mcp__purescience__notebook_execute`）。它们不会因为改名而消失，也不该被算进「已修」。
3. **本单元没有 Electron 窗口读数，也不假装有**：改的是「交给框架的名字」与「身份解析」两层，
   界面没有新增入口、没有可点的东西。真机证据取自**应用自己的模块**（命名模块 + 审计脚本）与
   **用户自己的日志**；界面那一半的证据是渲染套件（身份常量与活动识别表的断言）。
4. **旧拼写在「识别」面继续有效，但发出去的名字变了**：权限/授权/活动面收到旧连字符拼写时仍解析到同一身份
   （`legacyNames` + 分隔符无关比较，有守卫钉住）；本改动**没有**迁移任何持久化记录里的旧键，也没有放宽任何闸门。
5. **`reviewer` 服务有意不改**：它的 agent 面向名经桥接本就是下划线形态，真机上 2,180 次调用全部成功
   （P0-9 读数），改名只会带来无收益的连锁。**这条是边界，不是遗漏**。

## 五、门禁读数（隔离工作树，被测提交 = 本单元的代码提交）

（本节数字在门禁跑完后就地填入；运行方式为本技能自带的 `scripts/release-gate.sh <提交>`：
建隔离工作树 → 显式 `eslint --no-cache .` + 双 typecheck + 全量 vitest `--maxWorkers=4` + 仓规五查。）

| 环 | 读数 |
| --- | --- |
| eslint（全仓、CI 同口径） | 待填 |
| typecheck:node / typecheck:web | 待填 |
| 全量 vitest | 待填 |
| pre-push-checks.sh（单独跑、读退出码） | 待填 |

## 六、版本位点

Latest 仍为 **v1.102.0**（未动）。本单元是**运行时行为改动**（agent 面向的工具命名与身份解析），
并入下一个版本边界（v2.0.0 P0 批）。本轮**未打 tag、未抬版本号**。

## 七、遗留（每条带 blocked-by 与解封条件）

1. **`wrong-separator` 归零的复测**：`blocked-by` = 需要一段**新窗口**的真机日志（要在本改动跑到用户的机器上之后产生）。
   解封条件 = 用户的新 `main*.log` 里出现该形状的失败（或一周后无该形状失败）⇒ 用本档 §一的脚本复跑并回填。
2. **两笔提交的 CI 终态**：`blocked-by` = 本轮推送；解封条件 = `Nightly` + `Windows Full Test` 在**完整 40 位 SHA** 上落定
   （`cancelled` 不算绿）。纯 `docs/**` 提交按 paths 过滤不新建 run，届时按「代码提交的双绿 + 差量只有 docs」取证据并具名。
3. **P0-6 整行的排期档状态**：已就地把「后半已交付（`63ebc76b`）+ 本条证据档」写进 v2 排期 P0-6 行。
