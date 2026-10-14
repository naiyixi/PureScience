# PDBe 连接器（`structures-pdbe`，3 个工具）：源侧读数、两个编号方案与端点的取舍（执行器，2026-10-14）

> 本档只记**我自己发出的请求**与**我读到的原始值**，以及我**没有**取证的部分。
> 全部请求在 2026-10-14 17:4x（CST）从本机发出，落盘在 `/tmp/pdbe-*.json`（未进仓）。
> 服务：`https://www.ebi.ac.uk/pdbe/api/pdb/entry/...`（EMBL-EBI 的 PDBe）。

---

## 一 为什么做它：缺口与差异化红线

| 事实 | 读数 |
| --- | --- |
| 仓里此前有没有这套能力 | `grep -ril "pdbe\|gpcrdb" src/ --include=*.ts --include=*.tsx` 在我的三个文件之外**零命中** ⇒ 不是第二套实现 |
| 既有 `structures` 连接器给了什么 | RCSB 侧：条目检索/摘要/聚合物实体/配体（5 条工具）。**没有**「这一条结构里到底有哪些配体、按作者编号在哪条链上」、**没有**逐链二级结构、**没有**处理地/存放地的分列 |
| 与前者的边界 | 本连接器**只按条目取**、**不提供结构清单**（见 §四）；摘要里的日期一律是源自己的 `YYYYMMDD` 串，本工具不重格式化 |

三条差异化红线（写进了代码与 `description`，不是只写在档里）：

1. **两套残基编号并列返回、永不合并** —— 作者编号（+插入码）是 PDB 文件写、论文引的那个；label 编号是源在实体内的顺序位。`145` 与 `145B` 是两个**不同**残基。
2. **404 按端点各自命名** —— 配体那条明说「403/404 ≠ 什么都没结合」，并指回 `number_of_entities`。
3. **零请求拒答 + 服务省略的空列表读作空** —— 非法 id 一个请求都不发；源自己省略 `helices`/`strands` 键时读作「该链没有分配」，不读作「答案缺失」。

---

## 二 我自己发的请求与原始读数

| 请求 | HTTP | 我读到的原始值 |
| --- | --- | --- |
| `GET /summary/1cbs` | 200，740 B | `processing_site="BNL"`、`deposition_site=null`；`deposition_date=19940928` / `release_date=19950126` / `revision_date=20240207`；`number_of_entities={water:1, polypeptide:1, ligand:1, …}`；`assemblies[1]{monomer, homo, preferred:true}` |
| `GET /summary/4hhb` | 200，666 B | 同形 |
| `GET /summary/6lu7` | 200，698 B | **`number_of_entities={polypeptide:2, ligand:0, water:1, …}`**；`processing_site="PDBJ"`、`deposition_site="PDBJ"` |
| `GET /ligand_monomers/1cbs` | 200，309 B | 1 条：`chem_comp_id="REA"` / `chem_comp_name="RETINOIC ACID"` / `chain_id="A"` / **`author_residue_number=200`、`author_insertion_code=""`、`residue_number=1`（label）** / `weight=300.435` / `bm_id="bm1"` |
| `GET /ligand_monomers/4hhb` | 200，1874 B | **6 条**：`HEM`×4（链 A/B/C/D，作者编号 142/148/142/148）+ `PO4`×2（链 B/D，作者编号 147），**每条的 label 编号都是 1** |
| `GET /ligand_monomers/6lu7` | **404**，58 B | 与摘要的 `ligand:0` **自洽** |
| `GET /secondary_structure/4hhb` | 200，7970 B | 四条链（实体 1 的 A/C、实体 2 的 B/D）的 `secondary_structure` **只有 `helices` 键**（10/11/12/11 个），**没有 `strands` 键** |
| `GET /secondary_structure/6lu7` | 200，6422 B | 实体 1 链 A：`{helices:14, strands:19}`；**实体 2 链 C：只有 `strands`（1 个）、没有 `helices` 键** |
| `GET /summary/0aaa` | **404**，58 B | 正文逐字：`{"message":"Requested endpoint does not contain any data"}` |
| `GET /summary/9zzz`、`/summary/5xyz` | 均 200 | `9zzz` = "Nucleosome with an SSB at SHL +5.3 …"、`5xyz` = "The structure of human BTK kinase domain …" ⇒ **看起来像编造的 id 其实是真条目** |

---

## 三 三个会让读者误判的形状（本连接器专门处置的）

1. **配体的 404 不是「什么都没结合」。** `6lu7` 的摘要自己写着 `ligand:0 / polypeptide:2` —— 共价抑制剂被记成**第二条多肽实体**。所以 `pdbe_ligands` 的 404 文案把这条读法堵死，并要求先读 `number_of_entities` 再判「空结合位点」。
   *本条同时纠正我上一轮汇报里的一句话*：我上一轮把 `4hhb` 的 6 条写成「6 条 HEM」，实测是 **4 条 HEM + 2 条 PO4**。代码里没有依赖这个数字，但汇报里的数字是错的，在此更正。
2. **源会省略它要留空的那个键。** `4hhb` 全条目没有 `strands` 键、`6lu7` 链 C 没有 `helices` 键 ⇒ 读作「该链没有这项分配」，**不是**「答案缺了一块」。
3. **404 一词两用。** 「没有这条条目」与「该端点没有数据」回的是**同一句** `Requested endpoint does not contain any data`；工具**明说分不开**（二级结构那条的文案写着「this reader cannot tell those apart from the status alone」），不猜。

**两个编号方案**在真数据上确证：`1cbs` 的配体是**作者编号 200 / label 编号 1**，`4hhb` 的 6 条配体**label 编号全是 1**（因为分属不同实体）—— 只报一个而不标名字，调用者必指错残基。

---

## 四 端点的取舍（**具名**的缺口，不是静默省略）

| 端点 | 实测 | 决定 |
| --- | --- | --- |
| `/pdb/entry/ligand_sites|binding_sites|ligand_interactions/<id>` | 全 404（端点不存在） | 不做 |
| `/services/structure/<entry>` | 恒回 `[]` | 不做 |
| `/services/structure/`（全库清单） | **442 KB / 30 s** 一次 | **不做结构清单**：这么慢的清单不算工具 |
| `/pdb/entry/interface_residues/<id>` | 200 但 **339 KB**（原子级界面接触） | 本轮不做，具名留缺 |

---

## 五 本轮跑过的门禁

| 环 | 命令 | 读数 |
| --- | --- | --- |
| 连接器全目录 | `npx vitest run src/main/connectors --maxWorkers=2` | **89 文件 / 1001 passed（53 skipped）**，`Duration 7.32s` —— 含 `readme-connector-count.test.ts`（**读源测试**：它同时读两份 README 与注册表 ⇒ 「连接器 31 / 工具 282」这两个数是它核的，不是我抄的）与 `registry.test.ts` 的**双向一致性**断言（目录 id ⇄ 注册表 id） |
| 新描述符自己的用例 | `npx vitest run src/main/connectors/descriptors/structures-pdbe.test.ts` | **8 passed / 8** |
| 全仓 lint | `npx eslint --no-cache .` | `✖ 161 problems (0 errors, 161 warnings)`；其中**我自己的 4 个路径 0 条**（修前 14 条 prettier 漂移，已修） |
| 双类型检查 | `npm run typecheck:node` / `typecheck:web`（`--composite false`） | 两环 exit 0、无 `error TS` |
| 双语 README 头部块 | `node scripts/check-readme-sync.mjs` | `✓ 逐字一致`，exit 0 |

---

## 六 未取证（**具名**，不许当已取）

1. **窗口 / agent 面的读数未取** —— 内存闸门（空闲物理页 **18,893** ≈ **295 MB**，swap **7,542 / 9,216 MB** 已用）⇒ 本轮不起任何实例、不跑 `build:e2e` / Playwright。取到的是**端点级真读数 + 描述符用例**；「agent 在真回合里调到它」这一层未取。
2. **打包态复核** —— 属发版后动作。
