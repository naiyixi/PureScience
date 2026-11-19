# RO-Crate 第三方读校验（排期 v3.4 单元 4.2）

日期：2026-11-18 · 执行器 · 结论：**两个独立第三方实现都能完整读出我们的导出包**（PASS），
并在反方向（读别人的包）上**揪出一处真缺陷并当批修掉**。仍未做的两项（`author` / `license` 缺位）具名立案。

## 一 为什么要做

导出件的价值等于「别人能不能读」。我们的校验器与导出器是同一套代码（`src/shared/ro-crate.ts` 的断言
既被写入器自检、又被读取器复用），所以「我们自己的 30 条断言全过」只证明自洽，不证明可互操作。
本单元取的就是这一层：**用不共享任何代码的第三方实现读一次真包**。

## 二 取数方式（可复跑）

- 真包来源：**打包版数据根** `~/.purescience`（只读），项目 `cmw1m53zu0000jtnf7jtcbvfs`（CAR-T），
  `.provenance/*/versions/*/evidence.json` 实测 **1,735 份**版本记录；导出走产品自己的
  `writeRoCrateExport`，输入与 IPC 适配器（`src/main/ro-crate/ipc.ts:201`）给的**逐项相同**
  （`projectName` = 该项目真名 `CAR-T`、`app` 与 `generatedAt` 固定），**没有手工拼文档**。
- 导出读数：**278 个文件**、跳过 **0**、本仓校验器 **30 条断言 0 失败**、`@graph` **593 个实体**、
  包体 **97 MB**、`ro-crate-metadata.json` **1,376,212 字节**。
- 第三方：`rocrate 0.16.0`（ELIXIR 参考实现）+ `pyld 3.3.0`（通用 JSON-LD 处理器），
  装在 `/tmp` 的隔离 venv 里，依赖取自 TUNA 镜像。仪器入库：
  `docs/evidence/2026-11-18-ro-crate-third-party-read.py`。

## 三 正方向读数（第三方读我们的包）

| 读数       | rocrate 0.16.0                                                | pyld 3.3.0（JSON-LD 展开）                                            |
| ---------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| 载入       | 成功                                                          | 成功                                                                  |
| 实体数     | 593                                                           | 593（与文件里的 `@graph` 逐数相同）                                   |
| File 实体  | 278                                                           | 278（展开后类型 `schema:MediaObject`，即 1.1 上下文对 `File` 的映射） |
| 校验和     | 278/278 用**它自己的 hashlib 重算**后与声明逐字符相同         | 278/278 带展开后的 `http://schema.org/sha256`                         |
| 大小       | 278/278 与 `contentSize` 相同                                 | —                                                                     |
| 引用完整性 | `hasPart` 悬空 **0**、未被根可达的文件 **0**                  | `hasPart` 悬空 **0**                                                  |
| 溯源       | 278 个 `CreateAction`                                         | 278 个 `CreateAction`                                                 |
| 未展开的词 | —                                                             | **0**（本地 `sha256` 词声明被正确展开成 `http://schema.org/sha256`）  |
| 根实体     | `./` · `Dataset` · `conformsTo https://w3id.org/ro/crate/1.1` | 同                                                                    |

结论：**导出包可被两个互不相干的实现完整读出**，包括校验和与实体图。这是本单元要的那条证据。

## 四 反方向：读别人的包 → 抓到一处真缺陷（已修）

用 python `rocrate` 库写一个**别人格式**的包（`@context` 为 **1.3**、载荷在 `data/`、没有我们的
`CreateAction` / 定位符），再让**产品自己的读取器** `inspectExternalRoCrate` 去读。修前：

| 断言                                      | 级别            | 修前读数                                              | 判定                                      |
| ----------------------------------------- | --------------- | ----------------------------------------------------- | ----------------------------------------- |
| `context-references-ro-crate-profile`     | spec-should     | `@context: ["https://w3id.org/ro/crate/1.3/context"]` | **假红**：1.3 是同一条 profile 的更新版本 |
| `metadata-descriptor-conforms-to-profile` | spec-should     | `conformsTo: 1.3`                                     | **假红**（同上）                          |
| `crate-describes-at-least-one-payload`    | export-contract | `payloads: 0`                                         | **假读数**：包里明明有 `data/data.csv`    |

根因（读源）：`src/main/ro-crate/import.ts` 只枚举 `<crate>/files/`（**我们自己写入器的约定**），
`declaredPayloadIds` 也只认 `files/` 前缀 ⇒ 别人的包**一个文件都进不了判定**，它的字节从未被哈希，
而报告却给出「describes no payload」这种把读者引向错误方向的结论。RO-Crate **没有规定载荷目录**。

修法（两处，都在产品侧）：

1. `src/main/ro-crate/import.ts`：载荷集合 = **crate 根下真实存在的所有文件**（排除 `ro-crate-metadata.json`，
   不跟随符号链接）；声明 id 的准入改为「crate 相对路径」判据（无 URI scheme、非绝对、不含 `..`、
   解析后必须落在 crate 内）。越界读取的守卫**不放宽**——原有用例 `files/../outside.txt` 仍按名拒绝，
   新增用例 `data/measurements.csv` 证明别人的布局能被读且字节被真校验。
2. `src/shared/ro-crate.ts`：上下文与 `conformsTo` 接受 **任意 1.x**（我们仍只写 1.1）；
   并修掉一处「缺席读成不一致」——没有 `sha256` 的记录由 `file-sha256-recorded` 具名，
   不再同时被报成 `file-sha256-matches-copied-bytes`（`contentSize` 同）。

修后读数（同一个 python 写的包）：`context` / `conformsTo` 两条不再红，`payloads: 1`，
失败项只剩**真正缺失的四条**（`file-sha256-recorded`、`no-payload-without-action`、
`file-content-size-and-format`、`file-names-stored-version`）——每一条都是那条包真的没有的东西。
单测里另造了一个**装饰齐全**的第三方包（1.3 上下文 + `data/` 布局 + `CreateAction` + `sha256` + `contentSize`），
它的失败集合**恰好只有两条**自有定位符断言（`file-provenance-names-stored-version` /
`file-names-stored-version`）——这两条只有本应用写得出来，如实报出即为正解。

## 五 边界（不许读成更强）

1. **没有窗口读数**：本单元是数据层互操作验证，没有新增界面入口，也没有点过一次「导出」按钮。
   导出调用的是 IPC 适配器**同一个函数**、**同一组入参**（镜像而非重写），但**不是**一次点击取证。
2. **第三方只覆盖两种实现**：ELIXIR 参考库 + 通用 JSON-LD 展开。没有跑官方 `rocrate-validator`
   的 profile 级校验（它需要额外抓取 profile 与 JSON Schema，本机网络与时间都不允许）。
3. **包的载荷是用户真实数据**（97 MB，278 个产物版本），但其 `author` / `license` 为空（见下节），
   所以「可读」不等于「可被仓储收录」。

## 六 具名未办：crate 里没有作者与许可

两个第三方读者都给出 `root_has_author=false`、`root_has_license=false`。读源确认不是读者的问题：
`src/main/ro-crate/ipc.ts:201` 只把 `projectName` 与描述交给写入器，**`creators` / `publisher` / `license`
一个都没传**，于是 `buildRoCrateMetadata` 里那三个可选分支（`src/shared/ro-crate.ts:496-521`）从不生效。

为什么**没有当批补**：本仓「不许编造」——应用里没有任何一处记录过用户姓名或机构名（`Project` 只有
`name/description/caseTitle/...`），许可更是用户的选择，替用户填一个就是伪造出处。补它需要
**一个真实的来源**（设置里加「作者/机构」「默认导出许可」两栏）或**导出时让用户选**，两者都是独立单元。

验收判据（下一单元）：导出包里 `author` 与 `license` 都非空且可在第三方读者里读出；用户在设置里
改过之后，下一次导出逐字反映新值；没设过时**不写**这两个字段（不是写一个空串或猜一个默认值）。
