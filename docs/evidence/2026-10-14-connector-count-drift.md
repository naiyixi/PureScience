# 对外连接器计数与名单的漂移（2026-10-14，执行器）

> 一句话：成熟度块（Release 正文逐字复制的那一段）写着 **31 connectors (282 tools)**，而**同一份 README
> 的正文**与 `ROADMAP.md` 一直写着 **24**，名单也只列着旧的 24 个。上一次改计数只改了两份 README 的
> 成熟度块，正文与 ROADMAP **从未进过那份清单**。

## 一 逐处清单（改动前）

| 文件 | 行 | 原文 |
| --- | --- | --- |
| `README.md` | 20（引言句，双语头部锚点内） | `18 featured research skills and 24 built-in scientific connectors` |
| `README.md` | 123 | `It also includes **24 built-in** research connectors: <24 个名字>` |
| `README.md` | 294（比较表单元格） | `24 built-in connectors across genomics, …` |
| `README.md` | 329（功能表单元格） | `**24 built-in** research connectors, custom local/remote MCP connectors, …` |
| `README.en.md` | 20 / 122 / 221 / 256 | 同上四处（英文镜像逐处对应） |
| `ROADMAP.md` | 64（✅ 清单项） | `✅ 24 built-in connectors — 23 life-science data connectors … into 200+ callable tools` |
| `ROADMAP.md` | 118（能力表单元格） | `24 built-in connectors — 23 life-science data connectors (…) expanded to 200+ tools` |

注册表真实值（`ALL_CONNECTOR_IDS` 与 `getConnectorTools`）：**31 connectors / 282 tools**
（目录侧：25 个 `featured`（无 `group`）+ 6 个 `group: 'directory'`）。

**名单缺的 7 个**（正文那 24 个名字里没有）：PDBe、IEDB / Immune Epitopes、Sequence Analysis、
Chinese Term Resolution、ENCORI、PDC、Multi-Agent Orchestration。
README 那份名单混合了 featured 与 directory（PubMed / bioRxiv / ChEMBL / Clinical Trials 都是
`group: 'directory'`）⇒ 它**不是**某个分组的子集，就是一份没跟着长大的旧枚举。

## 二 来由（可查）

`docs/evidence/2026-10-08-iedb-connector-probe.md` 记着上一次的做法：「公开计数两处**同批改掉**：
**两份 README 的** `26 connectors (269 tools: …)` ⇒ `27 connectors (271 tools: … IEDB, …)`」——
那份「两处」＝两份 README 的**成熟度块**。同族的
`docs/evidence/2026-10-04-pdb-sequence-search.md`、`docs/evidence/2026-10-08-zh-medical-terms-connector.md`
也是同一口径。⇒ 正文与 ROADMAP 从注册表长到 31 起就没有人再看过。

## 三 修法与守卫

- 三份文件共 **7 处**计数与名单改为注册表真实值；`23 life-science` 与 `200+ tools` 两处**删掉具体数字**
  （前者按注册表已无法自证，后者改为 282，与成熟度块同一口径）。
- `src/main/connectors/readme-connector-count.test.ts` 的守卫从「只钉成熟度块」扩到：
  1. 成熟度块（原有）；
  2. **三份文件里每一处**计数都等于 `ALL_CONNECTOR_IDS.length`（新），且每份文件**必须**至少说一次
     （删掉句子 ⇒ 红，不能靠沉默脱钩）；
  3. 两份 README 的名单句**条数**等于注册表（新）。
- **变异证明**（断言不能是只会绿的摆设）：把引言里的 `31` 改回 `24` ⇒ 当场红
  （`expected { distinct: [ 24, 31 ] }`）；把名单里的 `PDC` 删掉 ⇒ 当场红（`listed: 30`）；两次恢复后绿。

## 四 没钉住的那一半（具名，不冒充）

名单里的**英文连接器名在仓内没有来源**：`src/main/connectors/catalog.ts` 的 `displayName` 是中文
（`化学`、`文献图谱`…），`descriptors/*.ts` 里只有注释提到英文名。⇒ 名字本身无法与任何真源对账，
**只有条数可核**。这一点写在测试注释里，没有假装名字也被钉住；要让名字可核需要先给目录补一列
（本笔不做，属另一件事）。

## 五 与 Release 的关系

成熟度块**未改**（它本来就是对的）⇒ Release 正文不需要重发；本笔是纯文档 + 测试改动，**不占补丁号**。
