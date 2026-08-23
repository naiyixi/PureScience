# PureScience Demo 校验报告：单细胞 QC 与批次效应（P3a 第七题）

> 目的：对 PBMC 单细胞 QC + 批次效应分析（P3 的领域变体，此前曾在正式环境实测但未独立复验）做**完整独立核验**。
> 校验方式：(1) 独立读取原始 h5ad 核对数据结构与内置注释；(2) **在干净目录独立重跑交付脚本**，确认全部关键数字逐位一致（最严格的可复现性检验）。
> 运行：2026-08-23 隔离 headless 实例（default-python 环境软链复用）；claude-code × deepseek-v4-flash；约 12 分钟。

---

## 1. 独立核对（原始数据层）✅

| 项 | agent 报告 | 独立读取 h5ad | 结果 |
|---|---|---|---|
| 细胞数 | 700（QC 后 700） | n_obs = **700** | ✅ |
| 基因数 | 765（HVG 500） | n_vars = **765** | ✅ |
| 注释列 | bulk_labels（粗分） | 存在，10 类（Dendritic/CD14+ Mono/CD19+ B/CD4+ T Reg/CD8+ Cytotoxic T…） | ✅ |
| mito 比例 | 分数形式 0.5%–4% | percent_mito ∈ [0.0048, 0.0400] | ✅ |
| 数据形态 | 已归一化/缩放（非原始 count） | X 稠密 float32 负值、raw 为 log1p 稀疏——**确认 agent 判断正确** | ✅ |

## 2. 独立重跑（脚本可复现性）— 关键数字逐位一致 ✅

在 `/tmp/p3a-verify` 干净目录用 default-python 重跑 `pbmc_pipeline.py`：

| 指标 | agent 报告 | 独立重跑 | 结果 |
|---|---|---|---|
| QC 前后细胞数 | 700 → 700（removed=0） | **700 -> 700 (removed=0)** | ✅ 逐位一致 |
| 基因数 / HVG | 765 / 500 | **765 (HVG: 500)** | ✅ |
| Leiden 聚类数 | 8（resolution=1.0, seed=42） | **8 (resolution=1.0)** | ✅ |
| 批次混合度（同批邻居比例） | 0.507 → 0.471 | **pre=0.507 post=0.471** | ✅ 逐位一致 |
| 注释一致率 / ARI | 74.4% / 0.631 | **74.4% ARI=0.631** | ✅ 逐位一致 |

**结论：脚本从原始 h5ad 可完整重跑，全部输出数字稳定——可复现性要求（P3 系列核心）实测通过。**

## 3. 方法学与诚实性评价（P3a 亮点）

1. **方法学正确性**：识别出 reduced 数据集上游已 normalize+log1p+scale、原始 count 未存——**主动放弃重跑 normalize_total**（对已归一化数据再归一化属方法学错误），并在脚本/报告中声明取舍与 `target_sum=1e4` 惯例。独立核查 X/raw 结构确认判断成立。
2. **规则先声明后执行**：QC 阈值（min_genes≥200、min_counts≥500、mito%≤10）先写入脚本再执行；0 剔除如实报告（数据已预过滤），未静默丢弃。
3. **不夸大伪批次结果**：奇偶伪批次校正前即接近随机混合（0.507），校正后 0.471——如实说明"伪批次不携带真实批次信号，仅验证工作流与指标"，未包装成真实批次效应结论。
4. **注释缺陷披露**：CD34+ 祖细胞（cluster 7）无对应标记被归为 NK、NK vs CD8 T 标记重叠——均显式披露。
5. **确定性验证自证**：agent 删输出→重跑→关键数字逐位一致（与本次独立重跑互相印证）。

## 4. 交付物（6 个）
`pbmc_pipeline.py`（单文件可重跑，参数集中 PARAMS）、`pbmc_qc_summary.csv`（分节：overview/过滤统计/阈值敏感性×8/主流程参数/批次混合度/每群标记+注释对照）、`pbmc_analysis.md`（含独立"已核实"与"限制"章节）、`qc_distributions.png`、`umap_batch_before_after.png`、`umap_annotation.png`

## 5. 运行状态说明（诚实记录）
- 会话技术状态 failed（隔离实例的已知模式：产物停留 .pending 未固化为不可变版本）；内容与方法学经本次独立重跑完全验证。正式环境重跑可完整固化。

## 6. 复现指引
新建会话 → 上传/引用 h5ad（scanpy 内置 `10x_pbmc68k_reduced`）→ 粘贴题目 → 绑定含 scanpy 1.12.3 + harmonypy 的环境 → 预计 10–20 分钟。

---

## 附录：证据
- 数据文件：`…/scanpy/datasets/10x_pbmc68k_reduced.h5ad`（scanpy 官方内置数据集，公开）
- 独立重跑目录：`/tmp/p3a-verify/`（脚本 + out/ 输出，可复现）
- scanpy 文档关于该数据集预处理的说明：https://scanpy.readthedocs.io/en/stable/generated/scanpy.datasets.pbmc68k_reduced.html
