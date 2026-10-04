# 入口层普查（第二轮）· 候选与已决事项 —— 2026-10-04

上一批（IC6–IC9）的判据是：**能力本体在（handler/契约/preload 三处齐）、但读者那一侧没有入口**。
本份用同一判据再做一次扫描，产出下一批候选，并把两条**本机做不到**的事具名归档。

## 一、扫描方法与结果

判据（可复现）：取 `src/shared/**` 里声明的字段名 → 筛「在 `src/main/**` 出现过」且
「在 `src/renderer/src/**` **一次都不出现**」→ 再按名字收窄到**「具名理由 / 状态」类**
（`reason|why|refus|denied|expired|stale|superseded|unavailable|failed|failure|skipped|deferred|
left_on|warning|notice|blocked|rejected|capped|truncat|empty|absent|missing`）。

不收窄是 **370** 个（多数本就该是内部字段）；收窄后是 **12** 个 —— 这正是 IC6 那一类的形状
（真实载荷类型里带着、main 在产出、屏幕上没人读）：

| 字段 | 读法（要判的三件事） |
| --- | --- |
| `boundConversationsUnavailable` | 哪个载荷类型带它？「不可用」的**理由**是否也随之而来？ |
| `deferredReason` | 逐条的延后理由上屏了吗，还是只上了一个「已延后」 |
| `emptyPageCount` | 空页计数有没有可读处（还是只报「无结果」） |
| `failedPhase` | 失败**发生在哪一相**有没有上屏（还是只说「失败」） |
| `failureKind` | 逐条失败类别是否上屏（早前域审计记过 0 命中） |
| `handoffFailure` | 交接失败的理由与去向 |
| `interruptionReason` | 中断理由（对照已交付的「具名拒绝/具名延后」体例） |
| `regionBlocked` | 被阻断的区域是否具名（还是整份判失败） |
| `retryableNetworkFailure` | 「可重试」这一定语有没有告诉读者 |
| `scriptTruncated` | 脚本被截断有没有说、截断在哪 |
| `unsealedReasons` | 未封存理由逐条 |
| `validationFailed` | 校验失败的具体项 |

**逐条要判的三件事**（照 IC6 的做法，判完再动手）：① 该字段真的出现在一个**用户可见载荷**里吗；
② 它的语义对读者有用吗（**没有理由的清单无法据以行动**）；③ 挂载点在哪（现有面板 / 菜单 / 状态行）。
三条都过才进批次；只过一两条的**归档并写明理由**，不许「为了凑数」做。

## 一之二、12 项的裁定台账（逐项三判，边判边记）

| 字段 | 裁定 | 依据 / 落点 |
| --- | --- | --- |
| `interruptionReason` | **真缺口，已修**（`ff05c41c`） | 而且比预想重：`failed/timeout/interrupted` 被同一个徽章一律印成 `error`，与 `repository.ts:273`「中断**不是**失败」直接冲突 ⇒ 改成按状态分说 + 具名原因 |
| `failureKind` | **真缺口，已修**（`db647e2a`） | main 逐条产出、渲染层零读；领域层注释写明 transport 可重试、invalid-response 该留档 ⇒ 运行块加类别细分 |
| `deferredReason` | **假缺口，划掉** | 面板 `:1040-1042` 早已按 `REASON_LABEL` 印「理由: 计数」——**以为没人读 ≠ 真的没人读** |
| `scriptTruncated` | **真缺口，已修**（`72a7ef38`） | 投影把标记丢掉 ⇒ 残缺脚本被展示、并被 `.ipynb` 导出携带；顺带修掉共用单元格里同款徽章问题，并把徽章规则抽成一个共享函数防漂移 |
| `failedPhase`（ACP 侧） | **部分** | 近亲 `HandoffLifecycleFailure.retryFrom` 已修（`ac8b3a4f`，载荷早有、main 在用、屏幕不读）；**ACP 错误事件上的相仍未上屏，继续挂着** |
| `validationFailed` | **假缺口，划掉** | `function-models.ts:110-111` 把它折成具名理由 `provider-unverified` 上屏 |
| `boundConversationsUnavailable` | **假缺口，划掉** | 载荷里恒为 `true` 的**常量**，读不读没有差别 |
| `emptyPageCount` | **真缺口，已修** | `PdfOpenResult` 带着它、两个消费面板都只取 `docId`；扫描版 PDF 打开后一片空白而无解释 |
| `unsealedReasons` | 待判 | 先进 MCP 工具结果（`:793`）⇒ 先查是否已由 agent 侧转达 |
| `retryableNetworkFailure` / `regionBlocked` | 待判 | main 用它们决定重试/换源（`claude-install.ts:412,442`）⇒ 先查最终失败是否已被具名上报 |
| `emptyPageCount` 之外的 PDF 面 | 已并查 | 见上 |

**注**：`unsealedReasons`、`retryableNetworkFailure`、`regionBlocked` 三项的第三条判据「该事实是否已由另一条路（agent 转达 / 具名失败）上屏」**尚未走完**——不是缺口，是**未判**。

## 二、两条本机做不到、已具名归档

### 1. IEDB 免疫学证据连接器（竞品 #3261）—— **环境阻断，不做**

探针（2026-10-04，本机）：

- DNS 正常：`query-api.iedb.org → 169.228.2.161`、`www.iedb.org → 169.228.2.144`；
- 但两个主站 **TCP 不通**：`GET https://query-api.iedb.org/epitope_search?limit=1` ⇒ `HTTP 000`（20s 超时）；
  `https://www.iedb.org/` ⇒ `HTTP 000`。**同一次会话里 RCSB 是通的**（1.5s），故非通用出网问题；
- `https://tools.iedb.org/` ⇒ **302**（可达，IP 8.37.117.210），但它服务的是**交互式网页**
  （`/mhci/`、`/bcell/` 均 200 的 HTML 工具页；`/api/`、`/epitope/`、`/tcell/`、`/database/` 全 404）——
  **没有可从本机使用的 JSON 查询接口**；
- 本机**无可用代理**：环境里只有 `NO_PROXY`，常见本地代理端口（7890/1087/8080/10809/6152）全关。

**决定：不实现**。理由：本仓口径是「禁空壳、声称完成必须附实机证据」——此连接器的上行链路在本机
（也就是在**使用者所在的网络**里）不可达，做出来就是**一个装了也没用的入口**；而唯一可达的那个主机
只给 HTML，靠抓页面来实现属于另一件事（脆弱且不许默默做）。

**将来要做时的差异化点（先列好，届时直接用）**：每条证据带**测定方法 / 宿主 / 参考文献**；
**绝不把「无记录」写成「阴性」**（查无结果时明确说「该查询无记录」，并列出查了什么）；
报 `total_count` / 已取 / 是否截断；输入形态不符（肽段非法字符、等位基因不在词表）**具名拒绝**。
**开工条件**：有一条能到达 `query-api.iedb.org` 的出网路径（代理配置 / 可达镜像）。

### 2. 其余立案（维持既有判断，不占排期）

IC6 真机「已收割」读数（需远程主机）、V8 窗口侧 60 秒（需沙箱子进程的被拦请求）、
M2 本地权重校验值（需发布方给出 SHA256）。三条都**不是没做**，是环境/数据受限。

## 三、下一批（v1.83.0）候选池

- **本份 §一 的 12 项**（逐条三判后取真缺口）；
- 已交付但可加深的：`pdb_search_by_sequence` 的**比对**（接口只给一致性打分，要出比对得另取实体序列自算）；
- 竞品窗口里已判「已对齐且更明确」的项**不重复做**（PDF 版式抽取、Windows 运行时专有项）。
