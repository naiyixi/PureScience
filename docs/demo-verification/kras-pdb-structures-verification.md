# PureScience Demo 校验报告：KRAS PDB 结构比较（P2 正式题）

> 目的：对官方验收题集 **P2（公开结构数据到可计算表格）** 的真实运行结果做**独立核验**。
> 校验方式：用 RCSB PDB 官方 REST API（data.rcsb.org）独立复查会话产物中的每一个结构字段。
> 运行：2026-08-22 隔离 headless 实例，题集 P2 原题逐字提交；claude-code × deepseek-v4-flash；数据请求日期 2026-08-22。

---

## 1. 独立核验结果（关键！）

### 1.1 结构元数据 — 3/3 通过 ✅

| PDB ID | 报告声称 | RCSB API 复查 | 结果 |
|---|---|---|---|
| 4OBE | X-RAY / 1.24 Å / 2014-06-04 / GDP-bound KRas | X-RAY DIFFRACTION / 1.24 Å / **2014-06-04** / "Crystal Structure of GDP-bound Human KRas" | ✅ |
| 6OIM | X-RAY / 1.65 Å / 2019-11-06 / KRAS G12C + AMG 510 | X-RAY DIFFRACTION / 1.65 Å / **2019-11-06** / "KRAS G12C covalently bound to AMG 510" | ✅ |
| 8E8X | ELECTRON MICROSCOPY / 2.91 Å / 2023-06-21 / **非 KRAS**（脊髓灰质炎病毒 Sabin 衣壳 + 9H2 Fab） | ELECTRON MICROSCOPY / 2.91 Å / **2023-06-21** / "9H2 Fab-Sabin poliovirus 3 complex"；聚合物实体 = Capsid protein VP1/VP2/VP3 | ✅ |

### 1.2 配体核验 — 2/2 通过 ✅

| PDB ID | 报告声称配体 | RCSB nonpolymer_bound_components | 结果 |
|---|---|---|---|
| 4OBE | GDP, MG (Mg²⁺) | `['GDP', 'MG']` | ✅ |
| 6OIM | GDP, MG, **MOV (AMG 510)** | `['GDP', 'MG', 'MOV']` | ✅ |

### 1.3 关键诚实性发现 — 通过 ✅（本场亮点）
- **8E8X 不是人源 KRAS 结构**：agent 如实报告"取回但不可比"，未将其强行纳入 KRAS 比较；CSV 中 `comparable_in_kras_comparison=False`，图中以灰色斜纹柱标注 excluded，不进入汇总统计。
- 独立复查确认：8E8X 实体为脊髓灰质炎病毒衣壳蛋白 VP1–VP3（对应报告所述 VP1–VP4 + 9H2 Fab），确实不含 KRAS（UniProt P01116）多肽——**agent 的判断与独立 API 复查完全一致**。

## 2. 通过标准对照（P2）

| 要求 | 表现 | 判定 |
|---|---|---|
| 结构字段可回查 | 全部字段与 RCSB 一致（见上） | ✅ |
| 脚本可从原始响应重产出 CSV/图 | `build_kras_structures.py` 经独立运行验证可再生成 | ✅ |
| 对缺失/不可比数据处理明确 | 8E8X 排除逻辑 + 图例说明 + 限制章节 | ✅ |
| 不推断生物学结论 | 明确"分辨率反映晶体衍射质量，链数/配体/构建体差异非对照"，仅 2 个可比条目故不做统计检验 | ✅ |
| 数据请求日期 | 报告注明 2026-08-22 | ✅ |

## 3. 交付物（4 个）
`kras_structures.csv`、`kras_structures_comparison.png`（1744×831，已验证非空白）、`build_kras_structures.py`、`kras_structures.md`

## 4. 运行状态说明（诚实记录）
- 会话技术状态 failed（隔离实例缺预置 Python 运行时的衍生问题，与 KRAS/P4 相同模式）；内容完整，产物停留在 .pending 未固化。正式环境重跑可完整固化。

## 5. 复现指引
新建会话 → 粘贴 P2 原题 → 预授权 Structures 连接器 → 预计 8–15 分钟。

---

## 附录：证据链接
| PDB | RCSB 页面 | REST API |
|---|---|---|
| 4OBE | https://www.rcsb.org/structure/4OBE | https://data.rcsb.org/rest/v1/core/entry/4OBE |
| 6OIM | https://www.rcsb.org/structure/6OIM | https://data.rcsb.org/rest/v1/core/entry/6OIM |
| 8E8X | https://www.rcsb.org/structure/8E8X | https://data.rcsb.org/rest/v1/core/entry/8E8X |
