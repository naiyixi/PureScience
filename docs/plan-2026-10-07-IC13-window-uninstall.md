# IC13 缺口收口：窗口里的「卸载包」——安全评审与落地设计（2026-10-07）

> 排期档 IC13 行的立案原文：「**窗口无法完成卸载** —— 准入 `package-admission.ts` 用
> `binding?.source === 'managed' && binding.envName ? … : defaultEnvironment(language)` 解析目标环境，
> 窗口没有会话 ⇒ 只到得了托管默认环境，而默认环境按设计 additive-only（`package-manager.ts:752`）。」
> 本文件把「改之前要单独的安全评审」补齐，并给出本轮取哪一条候选修法、判据在哪、什么不做。

## 一、现状（对源核实，不是复述记录）

| 事实 | 依据 |
| --- | --- |
| 卸载在**具名环境**上是允许的，只有托管**默认**环境是 additive-only | `src/main/notebook/package-manager.ts:748-773`（`isDefaultEnv` 门）；`package-manager.test.ts:961,1273` |
| 准入的**目标环境名**只来自会话绑定，请求里的 `environment` 被它**覆盖** | `src/main/notebook/package-admission.ts:82-86`、`:161`（`{ ...request, environment: environmentName }`） |
| 窗口（无会话）走的是 `runtime-selection-workflows.ts` 的 `managePackages`，它**按名解析**出环境后又**按名拒绝**非默认者 | `src/main/notebook/runtime-selection-workflows.ts:381-439`（`addressesDefault` 门） |
| 面板的具名环境行**已经有**「Packages」入口，且明确注释为**只读视图** | `src/renderer/src/pages/settings/RuntimesPanel.tsx:1223-1247` |
| 卸载按钮本身**没有**额外闸门 —— 它只是把请求交给主进程，由主进程拒绝 | 同上 `:1557-1562` |
| 具名环境的**权力面**：`manage_environments` 工具可对智能体**创建 / 移除**具名环境 | `src/main/notebook/mcp-server.ts`（`MANAGE_ENVIRONMENTS_DOC`：`action:"create"/"list"/"remove"`） |
| 包工具**没有** per-call 环境参数 | 同上 `MANAGE_PACKAGES_DOC`：「There is no per-call environment: bind/switch first」 |

⇒ 缺口是**精确的一条**：窗口没有任何一条路径能对「应用自己的具名环境」发起卸载 —— 它够不着默认环境
（策略禁止），也够不着具名环境（按名拒绝）。

## 二、两条候选修法与本轮取法

- **㈠** 让准入在**无绑定时**接受一个**受校验的环境名**。
- **㈡** 把**具名环境纳入窗口可达面**（面板已有入口，但请求现在按名拒绝）。

**本轮两条一起做，因为它们其实是同一处改动的两面**：准入必须学会「无绑定时接受一个经校验的名字」，
窗口才可能真的够得着；只做 ㈠ 而没有 ㈡ 的入口，就是一条没有消费者的通道（本仓明文禁止）。

## 三、安全评审（这是本单元存在的理由）

### 3.1 被保护的是什么

准入「只认会话绑定、请求里的名字对它透明」是**防重定向**的原意：智能体若能用请求参数点名环境，
就能把一次安装/卸载**挪到**用户没打算动的环境上（记录里叫「静默改指」，IC13 取证时真机上抓到过一次）。
所以放宽必须**同时**满足：改指不可能发生、目标可自证、默认环境不受影响。

### 3.2 为什么这不是一次提权（关键论证）

1. **智能体本就有更大的权力**：`manage_environments` 允许它**创建 / 移除具名环境**；移除整个环境
   严格强于移除环境里的一个包 ⇒ 给它（若它能走到这条路径）一个「按名卸载一个包」的能力**不增加**任何它现在
   做不到的事。
2. **请求侧根本没有这个参数**：包工具的契约写明没有 per-call 环境（`MANAGE_PACKAGES_DOC`），
   所以对智能体而言可达面**不变**；这次放宽只服务窗口那条已经存在、且已被按名拒绝的路径。
3. **目标必须自证**：名字必须能**在应用自己的具名环境登记册里**解析到（与面板同一份
   `manageNamedEnvironments({action:'list'})`），**不是**路径、不是 `envId`、不是外部解释器；
   解析不到就**按名拒绝**（不回落默认环境）。
4. **有绑定时一律不认**：只要会话**有**绑定，请求里的名字一律不生效（`binding` 胜出），
   重定向在结构上不可能发生 —— 智能体的路径永远是绑定驱动的那条。
5. **默认环境不变**：默认环境仍然 additive-only（`package-manager.ts` 那道门一个字节没动）。

### 3.3 fail-closed 规则（落地时必须逐条成立）

- **窗口侧**：名字解析不到 ⇒ **具名拒绝**（`runtime-selection-workflows.ts`），**绝不**把请求偷偷落到默认环境。
- **准入侧**：只认**能解析到具名环境**的名字，且**只在没有会话绑定时**（有绑定 ⇒ 请求里的名字一律不生效，
  重定向在结构上不可能发生）。解析不到的名字**保持本仓既有的钉定语义**（钉到默认环境）——
  两条既有具名用例（"pins every mutation target to it" / "pins a managed named target instead of trusting
  the request"）正是把这条钉住的，**没被改**；而默认环境的 additive-only 策略随后会**按名拒绝**那次卸载，
  所以「不可信的名字」既到不了具名环境、也到不了默认可卸载面。
- 名字解析到但**与绑定不一致** ⇒ 绑定胜出（不静默改指）。
- 名字解析到但该语言不匹配 ⇒ 不解析（钉默认；且卸载仍被默认策略拒）。
- 默认环境本身**不得**因为这条路径变成可卸载（策略门在 `package-manager.ts`，本轮不动它）。
- 该路径**不新开通道**、不改 `RuntimePackageMutation`（渲染层可见契约零变化）⇒ 零 pin 级联。

### 3.4 明确不做（本轮不主张）

- **不做**「拆掉默认环境」/「把默认环境改成可写」——那是另一件事，且与 additive-only 的基线策略冲突。
- **不做**外部（BYO）解释器的卸载 —— 现状按既有文案拒绝（`package-admission.ts:100-105`），本轮不动。
- **不做**智能体侧的新参数（3.2 第 2 条说明没必要，且会扩大可达面）。

## 四、落地清单（改动面）

| 文件 | 改动 | 判据 |
| --- | --- | --- |
| `src/main/notebook/package-admission.ts` | 新增端口 `resolveNamedEnvironment`；`admit` 在**无绑定**且请求带名字时按名解析，解析到就用它，否则**保持既有钉定语义**（钉默认） | 新用例三条：无绑定 + 合法名 ⇒ 落到该名；无绑定 + 非法名 ⇒ 仍钉默认（既有两条钉定用例**未改**）；有绑定 + 其他名 ⇒ 绑定胜出且解析器**根本没被调用** |
| `src/main/notebook/package-operations.ts` | 把新端口透传给准入 | 既有套件全绿 + 新用例 |
| `src/main/notebook/runtime-service.ts` | 从具名环境管理（`environmentManagement.manage({action:'list'})`）注入解析器 —— 与面板**同一份来源** | `runtime-service.test.ts` 相关簇绿 |
| `src/main/notebook/runtime-selection-workflows.ts` | `managePackages`：解析到**具名**环境时把名字交给准入，而不是按名拒绝；解析不到仍按名拒绝 | 新用例：具名环境 ⇒ 请求带名字；非具名不可寻址 ⇒ 原句拒绝 |
| `src/renderer/src/pages/settings/RuntimesPanel.tsx` | 只改**注释**（该对话框对具名环境不再是只读视图）；零行为改动、零新键 | 渲染套件不变 |

**零新通道 / 零新 i18n 键 / 零契约计数变动**（拒绝文案沿用主进程既有英文原句，渲染端照既有约定原样上屏）。

## 五、验收

1. **单测**：上表三处新用例 + 既有 `package-admission` / `package-operations` / `runtime-selection-workflows`
   套件全绿；**变异验证**（把放宽那一段回退，新用例必须红）——证明用例不是空跑。
2. **真机（认证车道同款）**：`e2e/certification/packages-mutation.spec.ts` 追加一段 —— 在隔离实例里建一个**具名
   环境**（走应用自己的创建入口），装一个真包，再从**面板的具名环境行**点进 Packages 对话框**卸载**它，
   断言：存储里该环境的清单**真的少了那个包**、且默认环境的清单**逐字节未变**。
   **✅ 已取（2026-10-07 夜）：`1 passed (53.5s)`** —— 该 spec 走的是「面板自己的 lock-import 入口建具名环境」，
   逐字读数、以及**没**证到的边界（R 语言 / 外部解释器 / 内核占用）见
   `docs/evidence/2026-10-07-ic13-window-uninstall.md`。
3. **拒绝路径的真机证据不得丢**：非具名不可寻址的请求仍必须得到那句按名拒绝（既有断言保留，只紧不放）。
