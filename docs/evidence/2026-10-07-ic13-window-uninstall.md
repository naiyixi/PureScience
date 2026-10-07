# 证据：IC13 窗口里的「卸载包」——具名环境按受校验的名字寻址（2026-10-07）

工作单/设计：`docs/plan-2026-10-07-IC13-window-uninstall.md`（含安全评审）。
本轮实现：`src/main/notebook/runtime-selection-workflows.ts`（窗口侧按名透传 + 地址性判据）、
`package-admission.ts`（无绑定时接受能解析到具名环境的名字）、`package-operations.ts` / `runtime-service.ts`（接线）。

## 一、真实事实（对源核实，不是推断）

| 事实 | 依据 |
| --- | --- |
| 准入此前**只**从会话绑定取目标环境，请求里的 `environment` 被覆盖 | `package-admission.ts`（`binding?.source === 'managed' && binding.envName ? … : default`） |
| 具名环境**可以**卸载（只有托管默认环境是 additive-only） | `package-manager.ts:748-773`（`isDefaultEnv` 门） |
| 窗口（无会话）此前**按名拒绝**具名环境 | 原 `runtime-selection-workflows.ts` 的 `addressesDefault` 门 |
| 面板的具名环境行**早就有**「Packages」入口 | `RuntimesPanel.tsx`（`data-testid="named-env-packages"`） |
| 面板列表与准入判定必须**同一份来源** | 现在两者都走 `NotebookEnvironmentManagementOwner.resolveNamedEnvironment` / `manage({action:'list'})` |

## 二、本轮观测值（实跑读数即结论）

### 2.1 真机（认证车道同款，本机隔离实例；`e2e/certification/packages-mutation.spec.ts`）

**`1 passed (53.5s)`**，`E2E_EXIT=0`。逐字读数：

```
[ic13] install notice: Done: purescience-probe.                       ← 默认环境装（对照，未变）
[ic13] removal refused: The default "default-python" environment is additive-only, so uninstalling
        is not allowed. …                                              ← 默认环境仍按名拒绝卸载（未变）
[ic13] named install notice: Done: purescience-probe.                 ← 具名环境**装**成功
[ic13] named env addressable=true installed=true importable=true      ← 环境自己的解释器能 import
[ic13] named removal target: matplotlib-base 3.11.0 — conda-forge Uninstall (name=matplotlib-base)
[ic13] named removal notice: Done: matplotlib-base.                   ← 具名环境**卸**成功
[ic13] named removal listed=false (re-read shows 82 rows, still has probe=true)
[ic13] default env untouched: 83 rows                                 ← 默认环境清单与操作前**逐行相等**
[ic13] range refused: … only a bare package name or an exact "name==version" pin is accepted …   ← 既有读数未变
```

判据逐条对上：**装**（真入口 → 真执行 → 环境自己能 import）、**卸**（重读清单里那一行真的没了，
而这次装进去的 `purescience-probe` 还在 ⇒ 不是「列表清空」造成的假象）、**越界防护**（默认环境清单
操作前后逐行相等 ⇒ 没有被静默改指）、**既有拒绝路径未被削弱**（默认环境卸载拒绝、范围规格拒绝都还在）。

### 2.2 单测与门禁

| 项 | 读数 |
| --- | --- |
| 定向四套件（准入 / 包操作 / 环境管理 / 工作流） | **50 passed**（新增 6 条：准入 3 / 工作流 2 / 环境管理 1） |
| 模块目录 `src/main/notebook` | **82 文件 / 1378 passed ｜ 99 skipped**，零失败 |
| 渲染设置套件 `src/renderer/src/pages/settings` | **63 文件 / 664 passed** |
| 双 typecheck | 净（`typecheck:node` 覆盖 `e2e/**/*`，**抓到过两处真错**：新 stub 里 `method:'micromamba'` 不在并集；spec 里 `namedClose` 重复声明） |
| `eslint --no-cache .` | **0 error**；触碰文件 0 problem |
| 变异验证 | 把放宽那段回退 ⇒ 新用例**红**（1 failed ｜ 15 passed），恢复 ⇒ 16 passed |

## 三、本轮**没**证到什么（具名边界，不冒充）

1. **R 语言具名环境**未取读数（本轮只跑了 python；R 的 `manage_environments` 与准入共用同一条路径，
   但「共路径」是推理，不是读数）。
2. **外部（BYO）解释器**的卸载仍按既有文案拒绝，本轮**未**动也**未**验。
3. **并发场景**未证：同一具名环境被笔记本内核占用时，移除是否按既有规则拒绝（那条规则在
   `environment-management.ts` 的 `remove` 分支，属宿主能力，不在准入路径上）。
4. 本轮的窗口路径**不新增通道、不改渲染层契约**，因此没有新的 pin/计数面需要复核 —— 这一条是
   **对源核实**（`runtime:manage-packages` 与 `RuntimePackageMutation` 一字未改），不是读数。

## 四、取证过程中抓到的两处真问题（都已修，都进用例）

1. **地址性判据写窄了**：第一版用「面板那一行是否解析到」来判定可寻址，而应用自己的 discovery 会把
   具名环境也列进来（`provenance: 'agent-created'` + `condaEnv`）⇒ 真实窗口的请求走的正是那条路，
   于是被判成「不可寻址」。真机读数把这条直接顶出来（弹的是新写的那句拒绝）。改成**按名字在应用自己的
   登记册里核对**（同时排除托管默认），并补了一条单测钉住这个形状。
2. **「列表为空」会被误读成「卸载成功」**：卸载后面板会重读清单，重读期间列表是空的（`Listing packages…`），
   此时断言「那一行不见了」是**假绿**。已改成：先等清单**重新回来**，再断言那一行不在，并顺带断言
   这次装进去的那条仍在。
