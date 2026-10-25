# 中文别名检索评测（v2.18 §4）

- 术语表：**40** 条（基因 10 / 蛋白 10 / 疾病 10 / 化合物 10）
- 被完整改写（unmapped 为空）：**40** 条（100.0%）
- 按命名拒绝：**0** 条

## 改写覆盖率（指标 2）

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

## 三源命中条数（指标 1、3）

| 术语 | pubmed | openalex | arxiv |
|---|---|---|---|
| TP53 | 40262 | 330992 | 38 |
| BRCA1 | 26203 | 171736 | 16 |
| EGFR | 154787 | 675726 | 124 |
| KRAS | 33465 | 315557 | 193 |
| APOE | 40389 | 192036 | 418 |
| MYC | 56393 | 450906 | 27 |
| PTEN | 28802 | 259773 | 11 |
| CFTR | 15732 | 78714 | 5 |
| HBB | 2885 | 38853 | 99 |
| MTHFR | 9181 | 43013 | 0 |
| p53 蛋白 | 73501 | 337751 | 19991 |
| 血管内皮生长因子 | 67568 | 885962 | 1193398 |
| 肿瘤坏死因子 | 229675 | 584539 | 7752 |
| 白细胞介素6 | 128068 | 1410167 | 17 |
| C反应蛋白 | 128096 | 2358601 | 14676 |
| 淀粉样蛋白 | 148054 | 551057 | 362 |
| 胰岛素 | 526248 | 2156475 | 353 |
| 血红蛋白 | 289308 | 1137515 | 188 |
| 肌钙蛋白 | 44158 | 241459 | 17 |
| 降钙素原 | 13064 | 96329 | 1 |
| 肺癌 | 512538 | 2548960 | 13181 |
| 乳腺癌 | pubmed returned no count | 2688961 | 11782 |
| 结直肠癌 | 353923 | 1254345 | 11202 |
| 肝细胞癌 | 181144 | 803200 | fetch failed |
| 2型糖尿病 | 234974 | 1611411 | fetch failed |
| 高血压 | 729255 | 3071027 | fetch failed |
| 脑卒中 | 540935 | 2666355 | fetch failed |
| 阿尔茨海默病 | 261405 | 723303 | fetch failed |
| 帕金森病 | 175855 | 561024 | fetch failed |
| 慢性阻塞性肺疾病 | 115995 | 666690 | 34378 |
| 阿司匹林 | 80795 | 444394 | 42 |
| 二甲双胍 | 38342 | 281906 | 16 |
| 他汀 | 76526 | 364955 | 38 |
| 华法林 | 36789 | 181862 | 37 |
| 氯吡格雷 | 19092 | 121533 | 3 |
| 紫杉醇 | 52671 | 334911 | 17 |
| 顺铂 | 100306 | 498152 | 15 |
| 曲妥珠单抗 | 18299 | 129465 | 6 |
| 纳武利尤单抗 | 14289 | 134107 | 2 |
| 瑞舒伐他汀 | 5596 | 50108 | 1 |

## 直接发中文的对照（抽样）

| 术语 | 源 | 英文查询条数 | 直接发中文条数 |
|---|---|---|---|
| TP53 | pubmed | 40262 | 40262 |
| TP53 | openalex | 330992 | 330992 |
| TP53 | arxiv | 38 | 38 |
| 肺癌 | pubmed | 512538 | 0 |
| 肺癌 | openalex | 2548960 | 155427 |
| 肺癌 | arxiv | 13181 | 0 |
| 脑卒中 | pubmed | 540935 | 0 |
| 脑卒中 | openalex | 2666355 | 7617 |
| 脑卒中 | arxiv | — | fetch failed |
| 阿司匹林 | pubmed | 80795 | 0 |
| 阿司匹林 | openalex | 444394 | 11920 |
| 阿司匹林 | arxiv | 42 | fetch failed |
| 二甲双胍 | pubmed | 38342 | 0 |
| 二甲双胍 | openalex | 281906 | 1460 |
| 二甲双胍 | arxiv | 16 | 0 |

## 口径

- 条数是各源自己报的命中总数（PubMed `esearchresult.count`、OpenAlex `meta.count`、arXiv `opensearch:totalResults`），不是我们的排序结果。
- 网络失败记成该源该条的具名错误，不记 0、不跳过。
- 被拒绝的术语仍然发出去量了（为了对照），但产品实际行为是**拒绝并点名**，不发半截查询。
- pubmed 行：`40262 / 26203 / 154787 / 33465 / 40389 / 56393 / 28802 / 157…`
