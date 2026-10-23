---
name: pyfastx-sequence-stats
contract: '{"id":"pyfastx-sequence-stats","aliases":["序列统计","FASTA 统计","GC 含量","序列条数"],"requires":["input:sequence_file"],"produces":["data:sequence_stats"],"failure_policy":{"missing_state":"Point the skill at a FASTA/FASTQ file first; sequence statistics describe an existing sequence set, they never create one."}}'
display_name: "Sequence Set Statistics (pyfastx)"
description: 用第三方工具 pyfastx 对 FASTA/FASTQ 做确定性统计（条数、总长、长度分布、N50、GC%），产出可直接引用的 TSV；数值一律来自工具输出，不自行估算。
tier: core
grade: tool-wrapper
status: canonical
backend: "pyfastx (第三方 CLI, `pyfastx stat`)"
---

# Sequence Set Statistics (`pyfastx-sequence-stats`)

> [!IMPORTANT]
> 这个技能的全部价值在于**数值来自真实工具**。任何"看起来合理"的序列数、长度或 GC 百分比，
> 只要不是 `pyfastx stat` 的输出，就是编造。

## 什么时候用它

用户给了一个 `.fa/.fasta/.fna/.fq/.fastq`（支持 `.gz`），问：

- 里面有多少条序列？
- 总长、长度分布（最短/中位/最长）、N50 是多少？
- GC 含量多少？
- 这个文件适不适合做下游比对/组装？

## 怎么做（只有一条路）

```bash
bash scripts/sequence-stats.sh <序列文件> [输出.tsv]
```

脚本做三件事，缺一不可：

1. 找到 `pyfastx` 可执行文件——`PATH` 里没有就说明**未安装**并以退出码 3 结束，
   **绝不改用估算**（macOS 上 pip --user 装的脚本常在 `~/Library/Python/*/bin/`）；
2. 调 `pyfastx stat`，把制表符结果原样写入 TSV；
3. 打印输出文件路径——这行就是可引用的产物路径。

默认输出位置是输入文件旁的 `<名字>.stats.tsv`。

## 输出怎么读

TSV 列（取用时就按列名引，不要自行换算单位）：

| 列 | 含义 |
|---|---|
| `seqCounts` | 序列条数 |
| `totalBases` | 总长（bp） |
| `GC%` | GC 含量 |
| `avgLen` / `medianLen` / `minLen` / `maxLen` | 长度统计 |
| `N50` / `L50` | 装配质量指标 |
| `seqType` | DNA/RNA/Protein |

## 护栏

1. **没跑工具就没有数字**。缺 `pyfastx` 时如实说"未安装，无法统计"并给出安装命令
   （`python3 -m pip install --user pyfastx`），不得用文件体积、行数或模型记忆估算；
2. **报告必须带出处**：引用 TSV 路径与列名，而不是一句"约 52% GC"；
3. **压缩文件不要先解压**：`pyfastx stat` 直接读 `.gz`；
4. **大文件不预览全文**：先用本技能拿统计，再决定要不要读序列本身；
5. **统计不是质控结论**：GC 偏高不等于污染，N50 低不等于组装失败——这些判断需要下游证据，
   本技能只提供输入画像；
6. **索引文件是缓存**：`*.fxi` 由工具生成，不要当作交付物。

## 与其它能力的关系

- 产物 `data:sequence_stats` 可被下游的结构/比对类技能直接消费；
- 若用户问的是"这些序列编码什么蛋白"，那是注释/比对任务，不是本技能。
