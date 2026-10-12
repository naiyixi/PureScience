# D1 真数据读数：判定逻辑在真实文件上（2026-10-12）

> 单测的自造夹具验的是"我写的形状能被认出来"，只有**真文件**才能验"真实形状会不会漏"。
> 本文件记录第一次真数据读数**抓到的缺陷**，以及**没取到的部分**（诚实并列）。

## 取数方式（可复跑）

探针跑在仓库内（`vitest`，跑完即删），`fetch` 两个真实来源：
- `https://files.rcsb.org/download/1CRN.cif`（真 mmCIF）与 `…/1CRN.pdb`（真 PDB）
- `https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v4.pdb`（真 AlphaFold 模型，B-factor 列即 pLDDT）

## ✅ 抓到的缺陷（真数据 vs 自造夹具的差别就在这里）

```
PROBE rcsb-cif bytes=69506 rcsb-pdb bytes=49491
PROBE formats: cif=cif pdb=pdb 无后缀时按内容判=pdb      ← 期望 cif，实际 pdb ✗
```

**成因**：内容判别只扫**前 4096 字节**找 `_atom_site.`，而真 RCSB mmCIF 的头部
（`_cell.` / `_entity.` / `_struct.` …）就超过这个窗口，`_atom_site.` 出现在后面的 `loop_` 里。

**修**：内容判别不设窗口（`/^\s*data_/m` + `content.includes('_atom_site.')`）；并加一条**复现真实形状**的用例
（头部塞满 `_struct_conf.` 字段、`_atom_site.` 落在 4 KB 之后，断言它仍判 `cif`）。
**修后重跑同一条真数据读数**：`无后缀时按内容判=cif` ✅。

> 教训（一句）：**"按扩展名判"永远是对的，出问题的只会是"按内容兜底"那条路** ——
> 而恰恰只有用户把文件改过名时才会走它，所以它才是真文件才能验的那一半。

## ✅ 阴性读数（同样有价值）

```
PROBE 1CRN isAlphaFold=false（期望 false）
```
普通 RCSB 结构**没有**被误判成 AlphaFold 产物（⇒ 不会给它一个没有含义的 pLDDT 配色）。

## ⛔ 未取（具名）

- **真 AlphaFold 模型那条**：`alphafold.ebi.ac.uk` 在本机取数失败（`bytes=n/a`）⇒ 探针如实打印
  "取数失败，本条不构成读数"，**没有**用自造夹具顶替它。要补：换一个可达的 AF 来源，或让用户侧网络就绪时再取。
- **带窗实例里的实看**（打开 PDB/mmCIF、旋转、换表示、换配色）：需要"会话里有文件 → 点开预览"的多步 UI 驱动，
  本刀只做到构建与判定层，**未取**。
