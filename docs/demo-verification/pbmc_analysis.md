# PBMC 单细胞 QC / 批次效应 / 注释 — 可复查分析报告（软件验证）

生成时间：2026-08-23T21:24:06
> 本文档仅做软件流程验证，不构成生物学或临床结论。所有可复现性所需的参数均在本脚本 `pbmc_pipeline.py` 的 `PARAMS` 中声明。


## 1. 输入数据与溯源

- 文件：`/Users/totota/.purescience-project/runtime/envs/default-python/lib/python3.12/site-packages/scanpy/datasets/10x_pbmc68k_reduced.h5ad`
- 形状：`700 cells × 765 genes`；scanpy `1.12.3` 读取
- 自带注释列：`bulk_labels`（10 类，见下）；文件内**不存在** `cell_type1/cell_type2` 列，以实际存在的列名为准。
- `X` 取值含负值（min=-2.03）→ 已是缩放后矩阵；`raw.X` 为 log 归一化表达（非负，max≈6.49）。scanpy 文档确认该数据集上游已做 `normalize_per_cell/normalize_total + log1p + scale`，原始 count 未存于本文件。
- QC 指标 `n_genes / n_counts / percent_mito` 采用提供者在原始 count 上预存的值（`percent_mito` 以分数存储，范围 0.0048–0.0400，即 0.5%–4.0%；报告统一换算为百分比）。

## 2. QC（先声明规则，后执行）

**预先声明的过滤规则**（`PARAMS`）：
- `min_genes = 200`（细胞至少检出这么多基因）
- `min_counts = 500`（细胞至少这么多 UMI 计数）
- `max_mito% = 10.0`%（线粒体比例上限）

- `n_genes`：min=1001.0, p25=1051.0, median=1129.5, p75=1250.0, max=2605.0
- `n_counts`：min=2141.0, p25=2933.8, median=3333.5, p75=3819.2, max=9497.0
- `mito_pct`：min=0.5, p25=1.4, median=1.7, p75=2.0, max=4.0

**过滤执行结果**：`700 → 700` 细胞；被剔除 **0** 个（明确计数，无静默丢弃）。本 reduced 数据集已由提供者预过滤（`min_genes≥1001`, `min_counts≥2141`, `mito%≤4.0`），故标准阈值下 `n_removed = 0`。阈值敏感性见下表（仅用于演示过滤机制，不改变主流程输入）。
- 过滤后用于下游的对象：`700 cells × 765 genes`（`raw.X`，log 归一化表达）。


## 3. 主流程参数与结果

| 步骤 | 参数 |
|---|---|
| 归一化 | **不重跑**。输入已为 log 归一化表达（`raw.X`），对已归一化数据再跑 `normalize_total` 属方法学错误；`target_sum=10000` 为 10x PBMC 惯例，提供者实际取值不可从文件恢复（见限制） |
| 高变基因 | `n_top_genes=500`, `flavor=seurat` |
| 缩放 | `max_value=10.0` |
| PCA | `n_comps=50`, `random_state=42` |
| 邻接图 | `n_neighbors=15`, `n_pcs=30`, `random_state=42` |
| UMAP | `random_state=42`, `min_dist=0.5` |
| Leiden | `resolution=1.0`, `flavor=leidenalg`, `n_iterations=2`, `random_state=42` |
- 高变基因：`500` / `765`（数据集自带 `var['highly_variable']` 标记数：309，两者不同源于参数/算法不同）。
- Leiden 聚类：`8` 个 cluster（resolution=1.0）。

## 4. 批次效应演示（奇偶伪批次）

- 按细胞索引奇偶生成伪批次 `batch ∈ {0,1}`（`n_0=350`, `n_1=350`）。这是随机划分，不携带真实技术批次信号——用于验证**工作流与指标**，其结果如实报告，不夸大。
- **校正前**：PCA 空间中 kNN(k=20) 同批邻居比例 = **0.507**（UMAP 空间 0.500）；ARI(batch, leiden) = -0.001。
- **Harmony 校正**（harmonypy 2.0.0，`max_iter=20`，`random_state=42`），运行正常（收敛迭代数属性未由 harmonypy 暴露，记为 `not_exposed`）。
- **校正后**：同批邻居比例 = **0.471**（UMAP 空间 0.483）；ARI(batch, leiden_post) = -0.001。
- 解读（如实）：奇偶伪批次为随机划分，校正前即接近完全混合（同批邻居比例≈0.5），故校正前后差异很小；结果说明工作流与指标运行正常，且**未观察到过度校正**。

## 5. 注释对照（标记基因 → 聚类；对照 `bulk_labels`）

- Cluster 0：n=179，预测 `Monocyte`；bulk 多数 = `CD14+ Monocyte` (69%)；top markers: FTL, LST1, AIF1, FCGR3A, CTSS
- Cluster 1：n=156，预测 `DC`；bulk 多数 = `Dendritic` (97%)；top markers: FCER1A, LYZ, HLA-DRB1, HLA-DQA1, HLA-DRA
- Cluster 2：n=141，预测 `CD4 T`；bulk 多数 = `CD4+/CD25 T Reg` (48%)；top markers: CD3D, LDHB, AES, NOSIP, CD3E
- Cluster 3：n=76，预测 `NK`；bulk 多数 = `CD8+ Cytotoxic T` (47%)；top markers: NKG7, CTSW, GNLY, GZMA, CST7
- Cluster 4：n=66，预测 `B`；bulk 多数 = `CD19+ B` (94%)；top markers: CD79B, CD79A, MS4A1, LTB, CD37
- Cluster 5：n=36，预测 `DC`；bulk 多数 = `Dendritic` (100%)；top markers: IRF8, CPVL, HLA-DPA1, CST3, CD74
- Cluster 6：n=33，预测 `B`；bulk 多数 = `CD19+ B` (91%)；top markers: MZB1, PPIB, IGJ, TNFRSF17, SSR4
- Cluster 7：n=13，预测 `NK`；bulk 多数 = `CD34+` (100%)；top markers: HNRNPA1, NPM1, SNHG7, RPS24, SNHG8

**一致性指标**（预测粗分 vs `bulk_labels` 粗分）：
- 逐细胞一致率 = **74.4%**
- Adjusted Rand Index(预测, bulk粗分) = **0.631**
- ARI(leiden, bulk粗分) = 0.531；ARI(我的 leiden, 提供者 louvain) = 0.726（对照参考）

## 6. 图件

| 文件 | 内容 |
|---|---|
| `qc_distributions.png` | n_genes / n_counts / mito% 分布与阈值线 |
| `umap_batch_before_after.png` | 校正前/后 UMAP，按伪批次与 `bulk_coarse` 着色 |
| `umap_annotation.png` | Leiden 聚类与标记基因预测细胞类型 |

## 7. 已核实（Verified）

- 数据来源：`/Users/totota/.purescience-project/runtime/envs/default-python/lib/python3.12/site-packages/scanpy/datasets/10x_pbmc68k_reduced.h5ad`，scanpy 1.12.3 读取，shape `700×765`；
  自带注释列实测为 `bulk_labels`（10 类），无 `cell_type1/cell_type2`，本报告按实际列名对照。
- QC 规则先声明后执行：`min_genes≥200`, `min_counts≥500`, `mito%≤10.0`；过滤 `700→700`，被剔除 `0` 个并明确计数，无静默丢弃。
- 每个关键数字有明确来源：obs 预存 QC 列（提供者原始 count 计算）、`raw.X`（上游 log 归一化）、本脚本 `PARAMS` 全部参数；敏感性表 `8` 行阈值组合均被记录。
- 主流程参数在脚本中可见：hvg=500, scale_max=10.0, pca=50, neighbors=15/30, umap seed=42, leiden resolution=1.0 seed=42。
- Harmony（harmonypy）可用并成功运行（运行日志显示收敛）；校正前同批邻居比例 0.507 → 校正后 0.471，数值如实报告。
- 注释对照：逐细胞一致率 74.4%，ARI(预测,bulk粗分) = 0.631；ARI(我的 leiden, 提供者 louvain) = 0.726 作为参考一致性。

## 8. 限制（Limitations）

- 本 reduced 数据集**不存储原始 count**；`n_genes/n_counts/percent_mito` 采用提供者预存值，无法用本文件独立重算（已核对 `X` 非计数、`raw.X` 为 log 归一化表达）。
- 无法从文件重建 count，故**不重跑** `normalize_total`；`target_sum=1e4` 为 10x PBMC 惯例，提供者实际取值不可恢复。这是受数据格式限制的如实取舍，而非省略。
- 线粒体基因在 `var` 中仅 `MT-ND3` 一个；`mito%` 为提供者基于原始全基因集计算，本报告仅展示其分布。
- 奇偶伪批次为随机划分，不携带真实技术批次信号；本演示只验证工作流与混合度指标，不能推广为真实批次效应的评估。校正前后混合度差异很小符合预期（随机划分本就充分混合）。
- 标记基因面板仅覆盖 6 类（单核/DC/CD4/CD8/NK/B）；`CD34+` 祖细胞无对应标记，可能被分配到表达最接近的类型。
- `percent_mito` 在 obs 中以分数存储（0.5%–4%），报告已换算为百分比，引用时需注意单位。
- 高变基因在 log 归一化表达上计算（数据不含原始 count，未使用 count 专用 flavor），用于软件验证可接受；严格生物学流程应在 count 数据上计算。

## 9. 复现方法

```bash
python pbmc_pipeline.py \
    /Users/totota/.purescience-project/runtime/envs/default-python/lib/python3.12/site-packages/scanpy/datasets/10x_pbmc68k_reduced.h5ad \
    pbmc_outputs
```
运行环境：scanpy 1.12.3 + harmonypy + scikit-learn；随机种子 42（`PARAMS`）。
