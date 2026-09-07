# 移液方案：GFP S65T/S65A 干-湿闭环实验

> 本方案由干实验计算自动生成；所有体积为“单反应”建议值，正式实施前需按实际试剂批次复核引物 Tm 与酶活单位。

## 1. OE-PCR 引物工作液

| 引物 | 序列 (5'→3') | 工作液浓度 |
|---|---|---|
| S65T_IF | `CGAGCCGAAGACTAACGGGAACAACCACAAGGACTACG` | 10 µM |
| S65T_IR | `TCCCGTTAGTCTTCGGCTCGATGTCCAGGATGCAGTCG` | 10 µM |
| S65A_IF | `CGAGCCGAAGGCTAACGGGAACAACCACAAGGACTACG` | 10 µM |
| S65A_IR | `TCCCGTTAGCCTTCGGCTCGATGTCCAGGATGCAGTCG` | 10 µM |
| OF (外侧5') | `GAGGCGAAGATCATCTTCGA` | 10 µM |
| OR (外侧3') | `GAACCTCACGTGGTGGATCT` | 10 µM |

> 完整引物表见 `@wet_handoff/primers.csv`（含 Tm 与 GC）。

## 2. OE 片段 PCR（每片段 50 µL 单反应）

| 组分 | 片段 A (S65T) | 片段 B (S65T) | 片段 A (S65A) | 片段 B (S65A) |
|---|---|---|---|---|
| 2× 高保真 PCR MasterMix | 25 µL | 25 µL | 25 µL | 25 µL |
| 模板（亲本 CDS/质粒 10 ng/µL） | 1 µL | 1 µL | 1 µL | 1 µL |
| 正向引物 | OF 1.25 µL | S65T_IF 1.25 µL | OF 1.25 µL | S65A_IF 1.25 µL |
| 反向引物 | S65T_IR 1.25 µL | OR 1.25 µL | S65A_IR 1.25 µL | OR 1.25 µL |
| ddH₂O | 补至 50 µL | 补至 50 µL | 补至 50 µL | 补至 50 µL |

PCR 程序（建议）：98°C 30 s → [98°C 10 s / 退火 (max Tm-5) 15 s / 72°C 30 s]×30 → 72°C 5 min → 4°C。

## 3. OE 组装反应（50 µL）

| 组分 | 体积 |
|---|---|
| 片段 A 纯化产物 | 1 µL |
| 片段 B 纯化产物 | 1 µL |
| 2× 高保真 MasterMix | 25 µL |
| ddH₂O | 23 µL |

程序：98°C 30 s → [98°C 10 s / 55°C 30 s（无引物重叠延伸）]×8 → 补加 OF/OR 各 1.25 µL → [98°C 10 s / 60°C 15 s / 72°C 45 s]×25 → 72°C 5 min。

## 4. 96 孔板加样（stopped 时间序列测定）

| 列块 | 突变体 | 铺板培养体积/孔 | 行（重复） | 终止时间 (min) |
|---|---|---|---|---|
| 列 1–4 | parent | 100 µL | A–H（8 重复） | 各列分别 0/10/30/60 |
| 列 5–8 | S65T | 100 µL | A–H（8 重复） | 各列分别 0/10/30/60 |
| 列 9–12 | S65A | 100 µL | A–H（8 重复） | 各列分别 0/10/30/60 |

| 步骤 | 操作 | 体积 |
|---|---|---|
| 加样 | 归一化(OD600≈0.05)诱导培养液加入指定孔 | 100 µL/孔 |
| 计时孵育 | 37°C，200 rpm 振荡 | — |
| 终止 | 到各列对应时间点加入 2% NaN₃ 终止缓冲 | 50 µL/孔 |
| 读数 | 全部终止后酶标仪 Ex485/Em510，读数 RFU | 1 read/well |

> 具体孔位以 `@wet_handoff/96_well_plate_layout.json` 为准（`well`/`mutant`/`timepoint_min`/`replicate`）。

## 5. 数据输出格式

| 列名 | 说明 |
|---|---|
| well_id | 孔位，如 A1 |
| mutant | parent / S65T / S65A |
| timepoint_min | 0/10/30/60 |
| replicate | 1–8 |
| RFU | 荧光读值 |

保存为 `wet_data_raw.csv`（UTF-8，含表头）。