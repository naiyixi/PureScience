# 中文「检查/测量手段」词条（procedure，20 条）：英文侧逐条取自 MeSH（2026-10-10）

口径与前两批**完全一致**（见 `2026-10-10-chinese-method-terms.md` §一）：**错映射比缺映射更糟**，所以英文侧
不是我在这里翻的，而是从 MeSH 的查询服务读出来的，并把**它当时返回的描述符号**逐条记进表；**中文侧是中文
医学文献通行的写法**，`source` **只承诺英文侧**。

**为什么单独立一类**：表里 `method` 的注释写的是「研究设计/统计/证据类型」，而本批是**做了什么检查/测量**
（影像、内镜、病理、检验、组学技术）—— 两类回答的是问题的不同半边（`磁共振成像 脑卒中` 里，前者是手段）。
`zh_terms.matched[].kind` 会把 kind 交给 agent，所以这个区分必须名副其实。

**归位的 6 行**：`免疫印迹法`/`流式细胞术`/`酶联免疫吸附测定`/`质谱分析`/`高通量测序`/`免疫荧光技术`
由自主执行器先落在 `method` 下，本次按上面这条线**归入 `procedure`**（英文侧与描述符号未改，仅 kind 归位）。

## 逐条（表 ↔ 本档互核）

| 中文（canonical）  | english                               | source       |
| ------------------ | ------------------------------------- | ------------ |
| 磁共振成像         | magnetic resonance imaging            | mesh:D008279 |
| 计算机断层扫描     | tomography, x-ray computed            | mesh:D014057 |
| 超声检查           | ultrasonography                       | mesh:D014463 |
| 超声心动图         | echocardiography                      | mesh:D004452 |
| 内镜检查           | endoscopy                             | mesh:D004724 |
| 活组织检查         | biopsy                                | mesh:D001706 |
| 病理学             | pathology                             | mesh:D010336 |
| 心电图             | electrocardiography                   | mesh:D004562 |
| 血管造影           | angiography                           | mesh:D000792 |
| 正电子发射断层显像 | positron-emission tomography          | mesh:D049268 |
| 免疫印迹法         | blotting, western                     | mesh:D015153 |
| 流式细胞术         | flow cytometry                        | mesh:D005434 |
| 酶联免疫吸附测定   | enzyme-linked immunosorbent assay     | mesh:D004797 |
| 质谱分析           | mass spectrometry                     | mesh:D013058 |
| 色谱法             | chromatography                        | mesh:D002845 |
| 细胞培养技术       | cell culture techniques               | mesh:D018929 |
| 高通量测序         | high-throughput nucleotide sequencing | mesh:D059014 |
| 免疫荧光技术       | fluorescent antibody technique        | mesh:D005455 |
| 原位杂交           | in situ hybridization                 | mesh:D017403 |
| 放射治疗           | radiotherapy                          | mesh:D011878 |

表的行数与本档的行数由读源测试**双向**钉住（`documented.size === rows.length` + 逐行比对 `english`/`source`）：
任一边漂了、或两边一起改了其中一个字段，测试都红。这一步不是说法而是可跑的命令：

```bash
node scripts/verify-mesh-sources.mjs            # 全表（含本批）
node scripts/verify-mesh-sources.mjs 磁共振成像   # 只查本批某几行
```
