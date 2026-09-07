# 干-湿闭环最终报告：GFP S65T / S65A vs 亲本

**项目**：虚构 GFP 突变体亲本 (mGFP_parent) → S65T / S65A 荧光活性比较（模拟干-湿闭环）  
**日期**：2026-09-04　**复现**：亲本序列种子 42；湿数据模拟种子 2024（见 `@wet_sim_parameters.json`）

## 0. 交付物索引
| 物 | 文件 | 生成阶段 |
|---|---|---|
| 引物表 (CSV) | `@wet_handoff/primers.csv` | 干 |
| 96 孔板布局图 (JSON) | `@wet_handoff/96_well_plate_layout.json` | 干 |
| 移液方案 (Markdown) | `@wet_handoff/pipetting_scheme.md` | 干 |
| 操作手稿 (Markdown) | `@wet_handoff/wet_protocol_manuscript.md` | 干（闭环备注见 §7） |
| 模拟湿数据 (CSV) | `@wet_data_raw.csv` | 湿注入 |
| 结果图 | `@final_figure_RFU.png` | 闭环 |
| 湿模拟参数 | `@wet_sim_parameters.json` | 湿注入 |

## 1. ① 干预测 (Dry Hypothesis)

### 1.1 亲本蛋白理论性质（Biopython `ProtParam`，基于 seed-42 确定性序列）
| 性质 | 值 |
|---|---|
| 序列 | 240 aa（第 65 位 = Ser，虚构亲本设定；反译合成 CDS 720 nt，GC 60.0%） |
| 理论等电点 pI | 5.94 |
| 分子量 | 28618 Da |
| 摩尔消光系数 ε280 (reduced) | 75285 M⁻¹·cm⁻¹（Gill–von Hippel: 5500·W+1490·Y+125·C） |

> 说明：S65T/S65A 均为中性氨基酸替换且不改变 W/Y/C 计数，故其理论 pI 与 ε280 与亲本一致；干预测的“活性”针对荧光强度 RFU（Ex485/Em510），不是 280 nm 蛋白定量。

### 1.2 突变设计（重叠延伸 PCR / OE）
| 突变 | 密码子变化 | 同源臂 | 干预期 `activity_fold` |
|---|---|---|---|
| S65T | TCT→ACT（单碱基） | 20 bp（18–22 bp 规格） | **+30% vs 亲本** |
| S65A | TCT→GCT（单碱基） | 20 bp（18–22 bp 规格） | **−50% vs 亲本** |

| 引物 | Tm (℃) | GC (%) |
|---|---|---|
| S65T_IF | 67.8 | 55.3 |
| S65T_IR | 69.5 | 57.9 |
| S65A_IF | 69.3 | 57.9 |
| S65A_IR | 71.0 | 60.5 |

> 完整引物序列见 `@wet_handoff/primers.csv`；板设计与终止时间见 `@wet_handoff/96_well_plate_layout.json`，操作与移液见 `@wet_handoff/wet_protocol_manuscript.md`、`@wet_handoff/pipetting_scheme.md`。

**Dry Hypothesis（H1/H2）**：H1：S65T 终点荧光（60 min RFU）显著高于亲本（活性约 +30%）；H2：S65A 显著低于亲本（约 −50%）。亲本居中。

## 2. ② 湿数据统计结果 (Wet Data)

数据源：`@wet_data_raw.csv`（96 孔 × 单次读数，stopped 时间序列；每孔标注 mutant + timepoint）。噪声 σ=5%（乘性高斯）；注入 2 个移液错误异常值。

### 2.1 质控（异常值识别，Tukey 3×IQR + ≥20% 中位偏差）
| 孔 | 突变体 | 时间点 (min) | RFU | 判定 |
|---|---|---|---|---|
| C12 | S65A | 60 | 195 | 注入的异常值（×2.95 加样尖峰），已剔除 |
| H11 | S65A | 30 | 9 | 注入的异常值（×0.29 加样不足），已剔除 |

自动检出与注入异常值**完全一致**（96 孔中恰 2 孔）。

### 2.2 60-min 终点：单因素 ANOVA（剔除异常值后）
**ANOVA**：F(2.0, 20.0) = 608.73，p = 1.22e-18（<0.001）

| 组 | n | RFU 均值 | SD | 显著性字母 (Tukey HSD) |
|---|---|---|---|---|
| parent (WT) | 8 | 123.9 | 3.8 | b |
| S65T | 8 | 163.2 | 7.7 | a |
| S65A | 7 | 63.1 | 4.2 | c |

**Tukey HSD 事后检验（Tukey-Kramer，α=0.05）**
| 比较 | 均值差 (RFU) | q | p | 结论 |
|---|---|---|---|---|
| S65T vs parent | +39.4 | 20.0 | 2.06e-11 | S65T 显著更高 |
| S65A vs parent | +60.7 | 29.8 | 1.29e-14 | parent 显著更高 |
| S65A vs S65T | +100.1 | 49.2 | 1.22e-15 | S65T 显著更高 |

**敏感性**：即使保留 2 个异常值（raw），60-min ANOVA 仍显著（F=18.6，p≈2.3e-05），字母仍为 a/b/c，结论稳健。

### 2.3 时间进程与斜率（活性折算）
| 时间点 (min) | 单因素 ANOVA p (清洗后) |
|---|---|
| 0 | F=0.5, p=6.40e-01 |
| 10 | F=91.9, p=4.12e-11 |
| 30 | F=297.8, p=1.33e-15 |
| 60 | F=608.7, p=0.00e+00 |

| 突变体 | 斜率 (RFU/min) | 相对亲本 fold | 对应干预期 |
|---|---|---|---|
| parent (WT) | 1.961 | 1.000 | 1.00（参考） |
| S65T | 2.615 | 1.334 | +30% |
| S65A | 0.946 | 0.482 | −50% |

**图**：`@final_figure_RFU.png` — (A) 各突变体 RFU 均值±SD 随时间；(B) 60-min 终点柱状图（均值±SD）标注 Tukey 显著性字母 **a (S65T) / b (parent) / c (S65A)**。

## 3. ③ 结论：哪个突变体显著优于亲本？

- **S65T 显著优于亲本**：60-min 终点 RFU 163.2±7.7 vs 亲本 123.9±3.8（差值 +39.4；Tukey p=2.06e-11；字母 a vs b）。
- **S65A 显著差于亲本**：RFU 63.1±4.2（差值 -60.7；Tukey p=1.29e-14；字母 c vs b）。
- 斜率活性折算：S65T ≈ +33.4%，S65A ≈ -51.8%，与设定 +30%/−50% 高度一致。
- 排序：**S65T (a) > parent (b) > S65A (c)**，三组两两显著差异（单因素 ANOVA F(2.0,20.0)=608.7，p=1.22e-18）。

## 4. ④ Dry↔Wet 关联证据与闭环判定

| 干预测 (Dry) | 湿证据 (Wet) | 关联文件 (@) | 判定 |
|---|---|---|---|
| 第 65 位 S、S65T/S65A 密码子 TCT→ACT/GCT（单碱基） | 编码验证：反译一致、变异蛋白翻译为 T/A | `@wet_handoff/primers.csv`、`@wet_handoff/96_well_plate_layout.json` | 支持 |
| 引物设计（两对 OE 内部引物，20 bp 同源臂；Tm/GC 如上） | 手稿第 3 节 + 移液方案可用 | `@wet_handoff/wet_protocol_manuscript.md`、`@wet_handoff/pipetting_scheme.md` | 支持 |
| H1: S65T 活性 +30%（高于亲本） | 60-min 终点 +41.8 RFU、斜率 fold≈1.33、Tukey 字母 a | `@wet_data_raw.csv`、`@final_figure_RFU.png` | **支持** |
| H2: S65A 活性 −50%（低于亲本） | 60-min 终点 −60.7 RFU、斜率 fold≈0.48、Tukey 字母 c | `@wet_data_raw.csv`、`@final_figure_RFU.png` | **支持** |
| t0 各突变体无差异（时间序列设计质控） | t0 ANOVA p≈0.64（不显著） | `@wet_data_raw.csv` | 支持 |

**闭环判定**：湿数据**未否定**任何干预期，反而在含噪声与 2 个异常值的条件下稳健复现了干设定 （S65T>亲本>S65A，两两显著）。因此**无需改写**操作手稿主体；已按规范在 `@wet_handoff/wet_protocol_manuscript.md` §7 追加“干-湿闭环反馈”备注以留痕。

> 透明性说明：本演示中湿数据由同一套 activity_fold 设定（+30%/−50%）作为 ground truth 模拟生成，目的是验证“统计管线能否从带噪+异常值数据中独立恢复干结论”；在真实项目中，wet_data_raw.csv 应替换为酶标仪实测值，若实测与干预测相悖，则须按 §7 流程改写操作手稿。

## 5. 复现环境
- Python 3.12.13 (conda env: kras-env)；Biopython 1.88；numpy 2.5.1；pandas 3.0.5；scipy 1.18.0；matplotlib 3.11.1
- 亲本序列：`random.seed(42)`；湿数据：`np.random.default_rng(2024)`；板布局确定性生成。