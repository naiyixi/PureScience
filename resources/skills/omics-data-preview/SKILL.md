---
name: omics-data-preview
display_name: "Large Omics File Preview (h5ad / VCF)"
description: 大文件组学数据的“先探后算”预览：只读结构与头部统计、按预算降采样（默认 2000 细胞），并强制标注子集范围；全量结论必须走算力决策链，不得用降采样结论定稿。
tier: core
grade: gold-wrapper
status: canonical
backend: "anndata/h5py (h5ad, optional) · Python 标准库 (VCF)"
---

# Large Omics File Preview (`omics-data-preview`)

> [!IMPORTANT]
> **先探后算（probe before compute）**：面对 `.h5ad` / `.vcf` 这类可能数 GB 的文件，第一步永远是读结构而不是读数据。

## 为什么需要它

单细胞矩阵与变异文件动辄 GB 级，直接载入会吃满内存并让会话卡死。本技能提供一条**确定性**的预览路径：
读元数据 → 按预算抽样 → 输出一份可校验的 manifest，交给应用层展示与后续调度。

## 铁律（护栏）

1. **子集必须标注（G6）**：任何降采样结果都必须携带 `subset` 信息（请求/实际/抽样方式），
   应用层据此生成“基于 N/M 降采样”的标签。**全量跑完之前，子集结论不得进入交付物**。
2. **全量走算力决策链（G1）**：需要完整数据的结果，必须按计算环境的就绪阶梯提议作业并等待批准，
   或明说“未计算：缺什么”，不得用预览结论冒充。应用层可直接取用
   `describeFullRunHandoff(manifest)` / `canAnswerFromPreview(manifest)`（`src/shared/omics-preview.ts`）
   生成的交接指令，不要自行措辞。
3. **不猜数值**：结构未知（依赖缺失、格式未识别）时如实写入 `notes`，并把 `fullRunRequired` 置为真，
   不要给出看似精确的估算。
4. **不修改输入**：预览路径始终以只读方式打开文件。

## 用法

```bash
python kernel.py --input data/pbmc.h5ad --subset-cells 2000 --out preview.json
python kernel.py --input cohort.vcf.gz --max-variants 50000 --out preview.json
python kernel.py --input cohort.vcf --full-scan --out preview.json   # 全量计数（大文件慎用）
```

输出 JSON 契约见 `src/shared/omics-preview.ts`（`OmicsPreviewManifest`，schemaVersion = 1）。

## 依赖

- `.h5ad`：优先 `anndata`（backed 模式，只读元数据）；无 `anndata` 时回退 `h5py` 读 `X` 形状；
  两者皆无 → 如实报告“结构不可读”，绝不臆测细胞数。
- `.vcf` / `.vcf.gz`：Python 标准库（`gzip`）流式计数，无需第三方依赖。

## 自测

```bash
python3 test_kernel.py
```
