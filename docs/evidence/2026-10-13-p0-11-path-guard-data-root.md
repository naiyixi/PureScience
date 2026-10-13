# P0-11 —— agent 路径闸门的「数据根」与存储层不同源（已交付 + 真机读数）

状态：**已交付**（提交 `15006211`，本机 dev 实例真机读数已取；本档即读数与提权论证）
单元来源：v2.0.0 批 P0-11（队列档 §六十三·三·5 立案；v2 线排期档 §二·补「P0-11」）

## 一 结论一句话

闸门把「数据根」**自己又解析了一遍**（`settings.dataRoot ?? 配置根`），而存储层用的是
`resolveDataRoot()`（`已配置值 ?? computeDefaultDataRoot()`）⇒ 在数据根与配置根**分开**的安装上
（本机 dev 布局就是这样），闸门把应用自己写入的目录判成「项目范围之外」，**agent 读不到自己的会话工作区
与自己的 notebook 产物**。改法不是放宽闸门，而是让闸门向**存储层自己的解析**要数据根（单一来源）。

## 二 缺陷与真机读数（改动前）

本机 dev 常驻实例（`~/.purescience-project` 配置根 / `~/PureScience-DEV` 数据根；
`settings.json` 里 **`dataRoot` 未设**）：

| 读数 | 值 | 取自 |
| --- | --- | --- |
| 闸门根文件 | `{"roots":["/Users/totota/.purescience-project"],"hint":"/Users/totota/.purescience-project"}` | 应用自己写的 `claude/hooks/path-guard-roots.json` |
| 存储层自报的数据根 | `/Users/totota/PureScience-DEV`（`isDefault: true`） | 应用自己的 `storage:get-info` |
| 配置根下的可迁移目录 | **不存在** `artifacts/notebooks/uploads/workspaces` ⇒ 不是遗留安装 | `ls ~/.purescience-project` |
| 真实拒答（应用自己的判定日志） | `~/PureScience-DEV/workspaces/<sessionId>/…` 多条 `deny` | `claude/hooks/path-guard-decisions.jsonl` |

**直接以应用注册的同一条命令跑已部署的守卫**（`node ~/.purescience-project/claude/hooks/path-guard.cjs`，
stdin 喂 PreToolUse 载荷），改动前：

| # | 探针载荷 | 判定 | 是不是缺陷 |
| --- | --- | --- | --- |
| 1 | `Bash`：本会话工作区里的脚本 `~/PureScience-DEV/workspaces/53a8675f…/gpcr_msm_kinetics_disconnect_sim.py` | **DENY** | 是（agent 自己的会话目录） |
| 2 | `Read`：同一工作区的 notebook 产物 `…/figC_pmf_hysteresis.png` | **DENY** | 是（agent 自己的产出） |
| 3 | `Read`：`/etc/passwd`（负向对照） | DENY | 正确 |
| 4 | `Glob`：`/Users/totota/Documents/**`（负向对照） | DENY | 正确 |
| 5 | `Read`：`~/.cache/torch/hub/checkpoints/model.pt`（正向对照） | ALLOW | 正确（本就不该动） |

## 三 根因（读源，file:line）

`src/main/settings/agent-runtime-manager.ts:707`（改动前）：

```ts
const dataRoot = settings.dataRoot?.trim() ? settings.dataRoot : this.storageRoot
```

`this.storageRoot` 是 **配置根**（`service.ts:280` `options.storageRoot ?? resolveStorageRoot()`；
`storage-root.ts:23` 注释逐字「Fixed, dev-aware **config** root (DB, sessions, claude, skills, settings live here)」）。
用户没挑过数据根时该表达式回落到配置根，而存储层对**同一个概念**给出的是另一个值：
`resolveDataRoot()`（`storage-root.ts:144`）= 已配置值 ?? `computeDefaultDataRoot()`
= 「配置根下已有可迁移目录且没有 `<home>/PureScience[-DEV]`」才回落到配置根，否则 `<home>/PureScience`（dev 为 `-DEV`）。

⇒ 这就是「同一个概念被两条路径解析成两个值」。唯一写入方只有一处
（`claude-config-provision.ts:179` 的 `writePathGuard(configDir, options.allowedRoots, …)`，
生产调用者仅 `agent-runtime-manager.ts:735`）⇒ 修一处即修全。

## 四 修法

```ts
const dataRoot = resolveDataRoot()        // 与 artifacts / uploads / reviewer / storage 命令面同一个值
…
await this.skills.provisionClaudeConfig(… , { roots: [dataRoot, this.storageRoot], hint: dataRoot })
```

闸门根**仍是两项**（数据根 + 配置根，`pathGuardRootsFile` 去重），`hint` 指向**数据根**
（那句提示原本就说「项目文件所在的目录（Files 面板列出来的那个）」，指向配置根是在说假话）。
打包/遗留布局里两个概念本就同指一个目录（本机打包版实测：闸门根 `~/.purescience` 与工作区同根）
⇒ 去重后文件逐字节不变，本改动在那里是 **no-op**（有用例钉住）。

## 五 提权论证（可复查，按仓规三段）

**① 调用者是否已经有更强的权力。** 有，而且这正是被拒的那件事本身：agent 的每一次 `Bash` 都以
**该会话工作区为 cwd** 运行（`payload.cwd` 就在 `<数据根>/workspaces/<sessionId>` 里，见 §二 读数），
应用自己也在同一棵树里替它写 notebook 产物；`<数据根>/notebooks/<projectId>/<sessionId>/…` 是应用
自己的运行时写出来的。**拒绝这个目录没有保护任何东西**（同一进程的 notebook 运行时就写在里面），
只是让 agent 读不到自己的成果。允许它 = 把本来就该有的那一份还回去，不是新权力。

**② 被放宽的表面是否新暴露了参数。** 没有。根清单是**应用自己产出的数据**（不是请求字段、不是用户输入），
没有任何新通道、没有新工具参数、没有让渲染端或 agent 能指名目标的入口；本次改的是那份清单里
**放哪个目录**。可达面的变化精确为：**在该安装上多一个目录（存储层解析出的数据根）**。这个变化被下列判据按
「值来自单一权威 + 只在两概念不同时才出现」收窄。

**③ 逐条 fail-closed 规则（每条配一个具名用例或读数）。**

| 规则 | 判据 |
| --- | --- |
| 根只能来自应用自己的解析，绝不来自请求/agent | 根清单唯一写入方是 `writePathGuard`，生产调用者只有一处（§三）；本次改动没有新增入参 |
| 配置根必须仍在清单里（skills/hooks/DB 仍受保护） | 用例断言 `roots` 同时含数据根与配置根；本次读数两份都在 |
| 用户挑过的数据根必须生效（不能被原始设置值顶替） | 用例「fences to a data root the user picked」（旧写法连它也不认 ⇒ 变更测试里当场红） |
| 两个概念同指一个目录时**不得**改变行为 | 用例「writes the same fence file when both roots resolve to one folder」（逐字节相等） |
| 系统临时目录**仍然不在**清单里 | 守卫脚本自己加的那条注释与实现未被触碰（`readRoots` 处） |
| 权重缓存**仍然**放行、凭据与家目录通配**仍然**拒绝 | §六 的 3/4/5 号负向对照，改动前后逐条一致 |
| 读不到根文件时**放行**（既有设计，防「读不到根就砖死一轮」） | 未改动；这条比本次改动更宽，因此必须写在档里而不是默认它 |

## 六 改动后真机读数（同一实例、同一守卫、同一载荷）

**根文件**（由应用自己的代码路径在 `sessions:save-session` 触发的 spawn 装配里重写）：

```json
{
  "roots": ["/Users/totota/PureScience-DEV", "/Users/totota/.purescience-project"],
  "hint": "/Users/totota/PureScience-DEV"
}
```

**判定前后对照**（`bash /tmp/pathguard-probe.sh BEFORE|AFTER`，同一份已部署的 `path-guard.cjs`）：

| # | 探针载荷 | 改动前 | 改动后 |
| --- | --- | --- | --- |
| 1 | 本会话工作区里的脚本（`Bash`） | DENY | **ALLOW** |
| 2 | 同工作区的 notebook 产物（`Read`） | DENY | **ALLOW** |
| 3 | `/etc/passwd` | DENY | DENY |
| 4 | `/Users/totota/Documents/**` | DENY | DENY |
| 5 | `~/.cache/torch/hub/checkpoints/model.pt` | ALLOW | ALLOW |

三条负向/正向对照**逐条不变** ⇒ 本次不是「把闸门整体放宽」。

**触发方式**（可复跑；`/tmp/p011-probe.py`）：重启实例到含本改动的代码 →
`projects:create` → `acp:create-session`（`permissionProfile:"auto"`）→ `sessions:save-session`
（**这一步就触发了重写**，说明装配发生在 spawn 配置构建处，不必等一轮真回合）→ `acp:resume-session`
→ `acp:send-prompt`（真回合确实派发：日志 `prompt start { sessionId: 60f98ea9…, textLength: 24 }`，
正是 `Reply with exactly: PONG` 的长度）→ 读根文件 → 探针 5 条 → `projects:delete`。

**边界（不许读成别的）**：
- 本读数证明的是**守卫对同一批载荷的判决变了**（真机、真部署产物、真根文件）；
  「agent 在**一轮真回合里**成功读到自己的产物」这一步没有单独取证 —— 它需要一轮里恰好发出那条
  `Bash`/`Read`，属下一窗口的窗口侧读数。判据链是「判决变了 + 拒答此前逐字出现在真实会话里」。
- 探针直接跑守卫脚本，会往 `claude/hooks/path-guard-decisions.jsonl` **追加探针行**：
  本次共 **10 行**（改动前 5、改动后 5，行数 20→25→30）。该文件是守卫自己的判定证据面，
  探针行没有时间戳，辨认方式是「连续 10 行、target 恰为上表那五个载荷」。
- 打包版**未重跑**：其两个概念本就同根（§四 的 no-op 论证 + 去重用例），且打包版的库要等下一次
  发版运行新代码才会再走这条路径 ⇒ 具名待下一次发版后复核（沿用 v2 排期档 §二·补 里那条口径）。

## 七 门禁读数

| 环 | 读数 |
| --- | --- |
| 定向单测 | `vitest src/main/settings src/main/storage-root.test.ts` ⇒ **88 文件 / 1433 passed｜3 skipped**；本文件 18 条（含新增 3 条） |
| 变异测试 | 把源码改回旧表达式 ⇒ 新增用例 **2 条当场红**（证明断言非空），改回即绿 |
| `typecheck:node` | **exit 0**，0 条 `error TS`（裸 `tsc` 不带 `--composite false` 会喷一屏 TS6307，那是用法错） |
| `typecheck:web` | **exit 0**，0 条 `error TS` |
| `eslint --no-cache` | 本批两文件 **0 问题** |
