# 批次 ③（权限门）第一步核实：扫「真有写路径的工具」清单（2026-10-08）

**结论：清单非空，但四个判据里有三个已被既有机制覆盖；唯一真缺口是「审批卡不区分『发一次查询』与『在他人服务上留下东西』」。**
仓规口径：部分覆盖 ⇒ **扩展既有实现**，不为已覆盖的面再加门（先例 G3：为不存在的能力加 UI/字段不成立）。

## 一、扫出来的东西（`src/main/connectors/descriptors/*.ts`）

**先纠一个最容易犯的错：`POST` 不等于「写」。** 本仓 20+ 个 descriptor 用 POST，逐个看上下文后，绝大多数是 **POST-as-query** —— 服务只提供 POST 端点，语义纯粹是读：

| 落点 | 实际语义 |
| --- | --- |
| `cancer-models.ts:563,632`（cBioPortal `fetch`）／`clinical-genomics.ts:317,522`（CIVIC、OpenTargets GraphQL）／`variants-gnomad.ts:453`（gnomAD GraphQL）／`genes-proteins.ts:53`（MyGene query）／`genes-gprofiler.ts:148`／`structures-pdb.ts:468,586`（PDB 检索）／`variants-mavedb.ts:155`／`rna.ts:462`（Rfam `search/sequence`）／`genes-reactome.ts:74`／`research-resources.ts:72` | **读**：把查询条件放进 body，不建持久状态 |

**真正的写路径只有两处：**

| # | 落点 | 为什么是写 |
| --- | --- | --- |
| 1 | `genes-enrichr.ts:77` → `POST https://maayanlab.cloud/Enrichr/addList`，回带 `userListId`（`:91`）供后续 `enrich?userListId=…`（`:98-99`）使用 | **在第三方服务上建立持久条目**：用户的基因列表被登记到对方的服务器上，并由一个 id 引用；这不是「把查询发出去」，是「留下东西」 |
| 2 | `job-transport.ts:100`（`method: 'POST'`）—— 远程作业提交/传输 | 在**远程主机**上创建作业与文件 |

## 二、批次 ③ 的四个判据，逐条对既有机制核实（file:line）

| 判据 | 读数 | 落点 |
| --- | --- | --- |
| ① **默认拒绝**（不是默认允许后提示） | ✅ 卡片**无人应答即自动拒绝**（"Unanswered requests are auto-denied after `timeoutMs` so a call can never hang the kernel indefinitely"）；且**审批通道缺席时 fail-closed**（"a call that is neither pre-allowed nor skip-approved fails closed when this transport is absent"） | `src/main/connectors/approval-broker.ts:28-38`；`src/main/connectors/service.ts:38-41` |
| ② **具名拒绝** | ⚠️ **部分**：闸门有具名码（`connector_unavailable` / `connector_disabled` …），但**拒绝的理由里没有「这次调用会写」这一条**——见第四节 | `src/main/connectors/service.ts`（`ConnectorGateError`） |
| ③ **面板可见 + 就地撤销** | ✅ 授权面板在位，且有渲染测试；注册表提供 `revoke()` 并返回被移除的行 | `src/renderer/src/pages/settings/PermissionsPanel.tsx`（+ `.render.test.tsx`）；`src/renderer/src/pages/settings/ConnectorDetailView.tsx`；`src/main/permission-grants/registry.ts:57,420-450` |
| ④ **没有可写路径的工具不加门** | ✅ **无需新增任何门**：连接器闸门覆盖**每一次**连接器调用（不只是写），所以「为写路径再加一层」本身就是多余的门 | 同上 `service.ts` |

**远程作业那一条（#2）不算缺口**：它已被 **compute 侧**的审批闸门 + 执行保护策略覆盖 —— 策略在审批卡之前就按 `deny` 具名拒绝（v1.90.0 交付的 `protection_refused`，见 `shared/execution-protection.ts` 与 `compute-approval-broker.ts`），有面板（`ExecutionProtectionPanel`，`data-slot="protection-policy-*"`）且策略可改。

## 三、唯一真缺口（具名）

**审批卡只说「这是一次调用」，不说「这次调用会在别人的服务器上留下东西」。**
现有文案全部是**范围/时长**语义 —— `ws.approvalScopeOnce`「Approval applies to this call only」、`ws.approvalScopeProject`、`ws.approvalScopeGlobal`、`ws.approvalScopeSession` …（`src/renderer/src/i18n/en.ts:4291-4296`）。用户看到「仅限这次调用」，**无法分辨**这次调用是「把查询发出去」还是「在第三方服务上登记了一份你自己的数据（可被 id 引用）」。

- **为什么算真缺口而不是措辞**：`Enrichr/addList` 的后果**超出这次请求**（对方持有一个可由 id 取回的用户列表），而「仅限这次调用」这句话会让人以为影响随请求结束。把「留下东西」写清楚，是让**做决定的人**拿到他真正需要的那条信息。
- **建议落点（不新增通道、不新增契约面）**：给 descriptor 加一个**可选的**「这次调用会在服务上建立什么」标记（如 `persistsOnService?: { kind, description }`），由**审批卡**在既有文案旁多印一句；缺该标记时**什么都不加**（不得猜测哪些工具是写）。
- **判据（可写成断言）**：① 带该标记的工具，其审批卡**必然**渲染那一句（并在九语字典里各有一条）；② 不带标记的工具**不渲染**（防全量乱印）；③ 该标记与「实际会 POST 到建立状态的那个端点」的对应关系有**读源测试**钉住（改端点即红）——否则标记会漂移到与行为不符。
- **不做**：**不新建第二套门**（既有闸门已 deny-first 且可撤销）；不给 POST-as-query 的 20+ 个工具加任何东西；`job-transport` 不重复加门（compute 侧已有）。

## 四、下一步

1. 按第三节落地那一个标记 + 审批卡那一句 + 三条判据的用例，**先声明形状再动手**（它要动 `shared` 的 descriptor 类型与审批卡文案，九语字典要同批补齐）。
2. 本批次**不开新门**：①②③④ 里 ①③④ 已在位，② 只差「写」这一条信息。
