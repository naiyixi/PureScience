# 中文别名检索评测（v2.18 §4）

- 术语表：**40** 条（基因 10 / 蛋白 10 / 疾病 10 / 化合物 10）
- 被完整改写（unmapped 为空）：**40** 条（100.0%）；按名拒绝 0 条

## 指标 1：top-5 命中率（判据是「标题里真的出现该术语」，不是总条数 > 0）

| 源 | top-5 命中 | 命中率 |
|---|---|---|
| pubmed | 30/40 | 75.0% |
| openalex | 37/40 | 92.5% |
| arxiv | 22/40 | 55.0% |

## 指标 2：改写覆盖率

| 术语 | 类型 | 结果 | 发送的查询 | 未映射残留 |
|---|---|---|---|---|
| TP53 | gene | 改写 | `TP53` | — |
| BRCA1 | gene | 改写 | `BRCA1` | — |
| EGFR | gene | 改写 | `EGFR` | — |
| KRAS | gene | 改写 | `KRAS` | — |
| APOE | gene | 改写 | `APOE` | — |
| MYC | gene | 改写 | `MYC` | — |
| PTEN | gene | 改写 | `PTEN` | — |
| CFTR | gene | 改写 | `CFTR` | — |
| HBB | gene | 改写 | `HBB` | — |
| MTHFR | gene | 改写 | `MTHFR` | — |
| p53 蛋白 | protein | 改写 | `tumor suppressor protein p53` | — |
| 血管内皮生长因子 | protein | 改写 | `vascular endothelial growth factor a` | — |
| 肿瘤坏死因子 | protein | 改写 | `tumor necrosis factor-alpha` | — |
| 白细胞介素6 | protein | 改写 | `interleukin-6` | — |
| C反应蛋白 | protein | 改写 | `c-reactive protein` | — |
| 淀粉样蛋白 | protein | 改写 | `amyloid` | — |
| 胰岛素 | protein | 改写 | `insulin` | — |
| 血红蛋白 | protein | 改写 | `hemoglobins` | — |
| 肌钙蛋白 | protein | 改写 | `troponin` | — |
| 降钙素原 | protein | 改写 | `procalcitonin` | — |
| 肺癌 | disease | 改写 | `lung cancer` | — |
| 乳腺癌 | disease | 改写 | `breast cancer` | — |
| 结直肠癌 | disease | 改写 | `colorectal cancer` | — |
| 肝细胞癌 | disease | 改写 | `hepatocellular carcinoma` | — |
| 2型糖尿病 | disease | 改写 | `type 2 diabetes mellitus` | — |
| 高血压 | disease | 改写 | `hypertension` | — |
| 脑卒中 | disease | 改写 | `stroke` | — |
| 阿尔茨海默病 | disease | 改写 | `Alzheimer disease` | — |
| 帕金森病 | disease | 改写 | `Parkinson disease` | — |
| 慢性阻塞性肺疾病 | disease | 改写 | `chronic obstructive pulmonary disease` | — |
| 阿司匹林 | compound | 改写 | `aspirin` | — |
| 二甲双胍 | compound | 改写 | `metformin` | — |
| 他汀 | compound | 改写 | `statins` | — |
| 华法林 | compound | 改写 | `warfarin` | — |
| 氯吡格雷 | compound | 改写 | `clopidogrel` | — |
| 紫杉醇 | compound | 改写 | `paclitaxel` | — |
| 顺铂 | compound | 改写 | `cisplatin` | — |
| 曲妥珠单抗 | compound | 改写 | `trastuzumab` | — |
| 纳武利尤单抗 | compound | 改写 | `nivolumab` | — |
| 瑞舒伐他汀 | compound | 改写 | `rosuvastatin` | — |

## 指标 3：源间命中矩阵（只比命中/未命中，不跨源比排名——三套语料不同）

| 术语 | pubmed | openalex | arxiv |
|---|---|---|---|
| TP53 | 未命中 | 命中 | 命中 |
| BRCA1 | 命中 | 命中 | 命中 |
| EGFR | 命中 | 命中 | 命中 |
| KRAS | 命中 | 命中 | 命中 |
| APOE | 命中 | 命中 | 命中 |
| MYC | 命中 | 命中 | 命中 |
| PTEN | 命中 | 命中 | 未命中 |
| CFTR | 命中 | 命中 | 命中 |
| HBB | 未命中 | 命中 | 命中 |
| MTHFR | 命中 | 命中 | 未命中 |
| p53 蛋白 | 未命中 | 命中 | 未命中 |
| 血管内皮生长因子 | 命中 | 未命中 | 未命中 |
| 肿瘤坏死因子 | 未命中 | 命中 | 命中 |
| 白细胞介素6 | 未命中 | 命中 | err |
| C反应蛋白 | 命中 | 命中 | err |
| 淀粉样蛋白 | 命中 | 命中 | err |
| 胰岛素 | 命中 | 命中 | err |
| 血红蛋白 | 未命中 | 命中 | 未命中 |
| 肌钙蛋白 | 未命中 | 命中 | 命中 |
| 降钙素原 | 命中 | 命中 | 未命中 |
| 肺癌 | 命中 | 命中 | 命中 |
| 乳腺癌 | 命中 | 命中 | 命中 |
| 结直肠癌 | 命中 | 命中 | 命中 |
| 肝细胞癌 | 命中 | 命中 | err |
| 2型糖尿病 | 命中 | 命中 | err |
| 高血压 | 命中 | 命中 | err |
| 脑卒中 | 命中 | 命中 | 命中 |
| 阿尔茨海默病 | 未命中 | 命中 | 未命中 |
| 帕金森病 | 未命中 | 命中 | 命中 |
| 慢性阻塞性肺疾病 | 命中 | 命中 | 命中 |
| 阿司匹林 | 命中 | 命中 | 命中 |
| 二甲双胍 | 命中 | 命中 | 命中 |
| 他汀 | 未命中 | 命中 | 未命中 |
| 华法林 | 命中 | 命中 | 命中 |
| 氯吡格雷 | 命中 | 命中 | 命中 |
| 紫杉醇 | 命中 | 命中 | 命中 |
| 顺铂 | 命中 | 命中 | 命中 |
| 曲妥珠单抗 | 命中 | 命中 | 未命中 |
| 纳武利尤单抗 | 命中 | err | 未命中 |
| 瑞舒伐他汀 | 命中 | err | 未命中 |

只有一个源命中的术语：**8** 条（p53 蛋白、血管内皮生长因子、白细胞介素6、血红蛋白、阿尔茨海默病、他汀、纳武利尤单抗、瑞舒伐他汀）

## 对照：直接发中文（抽样）

| 术语 | 源 | 改写后 top-5 | 直接发中文 top-5 | 改写后总条数 | 直接发中文总条数 |
|---|---|---|---|---|---|
| TP53 | pubmed | 未命中 | 未命中 | 40274 | 40274 |
| TP53 | openalex | 命中 | 命中 | 331184 | 331184 |
| TP53 | arxiv | 命中 | 命中 | 38 | 38 |
| 肺癌 | pubmed | 命中 | 未命中 | 512633 | 0 |
| 肺癌 | openalex | 命中 | 命中 | 2550347 | 155435 |
| 肺癌 | arxiv | 命中 | 未命中 | 13181 | 0 |
| 脑卒中 | pubmed | 命中 | 未命中 | 541070 | 0 |
| 脑卒中 | openalex | 命中 | 命中 | 2668051 | 7621 |
| 脑卒中 | arxiv | 命中 | 未命中 | 2551 | 0 |
| 阿司匹林 | pubmed | 命中 | 未命中 | 80803 | 0 |
| 阿司匹林 | openalex | 命中 | 命中 | 444589 | 11924 |
| 阿司匹林 | arxiv | 命中 | 未命中 | 42 | 0 |
| 二甲双胍 | pubmed | 命中 | 未命中 | 38352 | 0 |
| 二甲双胍 | openalex | 命中 | 命中 | 282089 | 1461 |
| 二甲双胍 | arxiv | 命中 | 未命中 | 16 | 0 |

## 口径

- 命中 = 该源返回的 top-5 标题里出现该英文术语（整词/短语、大小写不敏感）。总条数与命中是两个数，分开记。
- 网络失败记成该源该条的具名错误，不记 0、不跳过。
- 被拒绝的术语仍然发出去量了（为了对照），但产品实际行为是**拒绝并点名**，不发半截查询。
