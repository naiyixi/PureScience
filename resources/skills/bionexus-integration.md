# BioNexus 集成指南

PureScience 内置了 **BioNexus 生物医学技能包**（17 个技能，`resources/skills/bionexus-*`），
覆盖：单细胞 RNA 质控、空间转录组学、scVI 深度生成建模、Nextflow/nf-core 工作流、
变异解读（ACMG/AMP）、多组学整合、蛋白质结构与语言模型、生物制品设计、临床队列分析、
实验设计、Allotrope 数据标准化、知识图谱增强、来源与审计等。

## 数据连接器（可选）

BioNexus 插件同时提供 MCP 服务器（`mcp.json`）。**一键导入**：设置 → 连接器 →
导入模板 → 选择本文件同级的 `connectors/bionexus.json`（或直接粘贴其内容），
即可添加全部 7 个托管连接器（BioRender、Consensus、Synapse、Wiley、bioRxiv、
ClinicalTrials、ChEMBL）。

> 注：PubMed、bioRxiv、ChEMBL、ClinicalTrials 已作为 PureScience 内置连接器提供，
> 重复添加不影响使用；模板导入会跳过重名项。

**本地（stdio）：** 从 https://github.com/HERRY423/BioNexus 克隆插件，运行
`python scripts/local_mcp_server.py`（需 `pip install -e .`），然后在
设置 → 连接器 → 添加 → 自定义中添加该 stdio 服务器（命令 `python`，
参数 `scripts/local_mcp_server.py`，工作目录为插件根目录）。本地服务器统一访问
UniProt、Ensembl、gnomAD、PDB、AlphaFold DB、Reactome、STRING、GEO、GTEx。

## 使用提示

- `bionexus-start` 技能用于定位：先运行 `doctor.py`，按 tier 路由到核心金链技能。
- 启发式技能（biologics、pLM、ACMG、structure、multiome）默认隐藏，
  需显式请求并接受证据等级 C。
- 技能严格遵守"证据分级 + 缺失金标准后端即拒绝"的防火墙原则。
