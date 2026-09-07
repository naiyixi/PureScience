# PureScience 极限压测证据库（2026-09-04 → 09-07 · 30 题全量）

> 本目录为 **30 道对抗性研发压测题的全量证据**：每道题一个案例文件夹，内含该会话真实产出的裁决研报（Markdown）、数值求解器（Python）与出版级图件（PNG），全部来自本机会话 Files 面板，可版本回放。正文见仓库根 [README](../../README.md)。

| 数据 | 值 |
|---|---|
| 项目数 | 30（2026-09-04 → 09-07，本机 `~/.purescience-project`） |
| 硬件 | 单一 Apple M2 · 8 GB 内存 · 无集群 |
| 产物形态 | 中文裁决研报 + 数值求解器 + 出版级图件（每题 3–19 件，已按案例归档） |
| 诚实性规范 | 报告自带 Data-Gap 清单；「已验证 / 无法核实」分离；无实测值不参与裁决 |

## Wave 0 · 方法论地基（09-04）

### 01. foundation ultra stress
> 题目：极限压力测试题　·　2026-09-04 20:59:38

产物：[求解器 `01_build_merged_evidence.py`](cases/01-foundation-ultra-stress/01_build_merged_evidence.py) · [求解器 `02_make_kras_figure.py`](cases/01-foundation-ultra-stress/02_make_kras_figure.py) · [数据 `merged_kras_evidence.csv`](cases/01-foundation-ultra-stress/merged_kras_evidence.csv) · [归档(字节一致) `report.md.gz`](cases/01-foundation-ultra-stress/report.md.gz)

---

### 02. enzyme directed evolution
> 题目：酶工程定向进化——干湿闭环压力测试　·　2026-09-04 22:16:35

产物：[数据 `96_well_plate_layout.json`](cases/02-enzyme-directed-evolution/96_well_plate_layout.json) · [报告 `final_report.md`](cases/02-enzyme-directed-evolution/final_report.md) · [报告 `pipetting_scheme.md`](cases/02-enzyme-directed-evolution/pipetting_scheme.md) · [数据 `primers.csv`](cases/02-enzyme-directed-evolution/primers.csv) · [数据 `wet_data_raw.csv`](cases/02-enzyme-directed-evolution/wet_data_raw.csv) · [归档(字节一致) `wet_protocol_manuscript.md.gz`](cases/02-enzyme-directed-evolution/wet_protocol_manuscript.md.gz) · [数据 `wet_sim_parameters.json`](cases/02-enzyme-directed-evolution/wet_sim_parameters.json)

---

### 03. anti hypothesis selfcorr
> 题目：反事实验证与自我纠正（Anti-Hypothesis Test）　·　2026-09-04 22:43:24

产物：[归档(字节一致) `expression_analysis.py.gz`](cases/03-anti-hypothesis-selfcorr/expression_analysis.py.gz) · [数据 `raw_expression.csv`](cases/03-anti-hypothesis-selfcorr/raw_expression.csv)

---

### 04. selfplay automl
> 题目：自我博弈的 AutoML 调试循环（Self-Play AutoML）　·　2026-09-04 23:00:50

产物：[求解器 `classifier_v1.py`](cases/04-selfplay-automl/classifier_v1.py) · [求解器 `classifier_v2.py`](cases/04-selfplay-automl/classifier_v2.py) · [数据 `model_comparison.json`](cases/04-selfplay-automl/model_comparison.json)

---

### 05. adc bystander ifp adjudication
> 题目：矛盾文献仲裁与因果反转测试　·　2026-09-04 23:16:51

产物：[求解器 `adc_bystander_diffusion_model.py`](cases/05-adc-bystander-ifp-adjudication/adc_bystander_diffusion_model.py) · [图 `bystander_diffusion_model.png`](cases/05-adc-bystander-ifp-adjudication/bystander_diffusion_model.png) · [数据 `bystander_model_assumptions.json`](cases/05-adc-bystander-ifp-adjudication/bystander_model_assumptions.json) · [数据 `payload_properties_comparison.csv`](cases/05-adc-bystander-ifp-adjudication/payload_properties_comparison.csv) · [报告 `report.md`](cases/05-adc-bystander-ifp-adjudication/report.md)

<p align="center"><img src="cases/05-adc-bystander-ifp-adjudication/bystander_diffusion_model.png" alt="artifact bystander_diffusion_model.png" width="820" /></p>
---

### 06. ferroptosis glioma statistics
> 题目：跨学科生信数据逆向对齐与假阳性清洗　·　2026-09-04 23:40:44

产物：[求解器 `ferroptosis_glioma_model.py`](cases/06-ferroptosis-glioma-statistics/ferroptosis_glioma_model.py) · [归档(字节一致) `report.md.gz`](cases/06-ferroptosis-glioma-statistics/report.md.gz) · [数据 `results_audit_slc7a11.csv`](cases/06-ferroptosis-glioma-statistics/results_audit_slc7a11.csv) · [数据 `results_multivariable.csv`](cases/06-ferroptosis-glioma-statistics/results_multivariable.csv) · [数据 `results_summary.json`](cases/06-ferroptosis-glioma-statistics/results_summary.json) · [数据 `results_univariable.csv`](cases/06-ferroptosis-glioma-statistics/results_univariable.csv) · [数据 `results_vif.csv`](cases/06-ferroptosis-glioma-statistics/results_vif.csv) · [数据 `sim_cohort.csv`](cases/06-ferroptosis-glioma-statistics/sim_cohort.csv)

---

### 07. thalidomide imid chirality
> 题目：反向工程药物设计中的化学合成与立体选择性陷阱　·　2026-09-05 08:11:10

产物：[数据 `imids_feature_matrix.csv`](cases/07-thalidomide-imid-chirality/imids_feature_matrix.csv) · [报告 `report.md`](cases/07-thalidomide-imid-chirality/report.md)

---

## Wave 1 · 化学弹头与分子机器（09-05 上半）

### 08. ecoli pca metabolic thermo
> 题目：合成生物学与代谢通量平衡的“热力学与毒性盲区”　·　2026-09-05 11:54:34

产物：[求解器 `metabolic_flux_ode_sim.py`](cases/08-ecoli-pca-metabolic-thermo/metabolic_flux_ode_sim.py) · [报告 `report.md`](cases/08-ecoli-pca-metabolic-thermo/report.md) · [数据 `sim_summary.csv`](cases/08-ecoli-pca-metabolic-thermo/sim_summary.csv)

---

### 09. protac hook effect
> 题目：PROTAC 三元复合物非单调结合动力学与“钩状效应（Hook Effect）”建模　·　2026-09-05 12:25:13

产物：[求解器 `protac_hook_kinetics.py`](cases/09-protac-hook-effect/protac_hook_kinetics.py) · [报告 `report.md`](cases/09-protac-hook-effect/report.md)

---

### 10. cd8 pseudotime dissociation
> 题目：空间转录组与单细胞伪时序（Pseudotime）反向因果审查　·　2026-09-05 12:55:35

产物：[图 `fig1_pseudotime_drift_terminal.png`](cases/10-cd8-pseudotime-dissociation/fig1_pseudotime_drift_terminal.png) · [图 `fig3_module_kinetics_raw_vs_corrected.png`](cases/10-cd8-pseudotime-dissociation/fig3_module_kinetics_raw_vs_corrected.png) · [数据 `metrics_terminal_transfer.csv`](cases/10-cd8-pseudotime-dissociation/metrics_terminal_transfer.csv) · [数据 `per_cell_pseudotime.csv`](cases/10-cd8-pseudotime-dissociation/per_cell_pseudotime.csv) · [报告 `report.md`](cases/10-cd8-pseudotime-dissociation/report.md) · [数据 `sim_cd8t_counts.csv`](cases/10-cd8-pseudotime-dissociation/sim_cd8t_counts.csv) · [数据 `sim_cd8t_metadata.csv`](cases/10-cd8-pseudotime-dissociation/sim_cd8t_metadata.csv)

<p align="center"><img src="shots/46-cd8-session.png" alt="session 10-cd8-pseudotime-dissociation" width="820" /></p>
<p align="center"><img src="cases/10-cd8-pseudotime-dissociation/fig1_pseudotime_drift_terminal.png" alt="artifact fig1_pseudotime_drift_terminal.png" width="820" /></p>
<p align="center"><img src="cases/10-cd8-pseudotime-dissociation/fig3_module_kinetics_raw_vs_corrected.png" alt="artifact fig3_module_kinetics_raw_vs_corrected.png" width="820" /></p>
---

### 11. mab viscosity formulation
> 题目：复杂生物制剂（抗体/双抗）配方热力学稳定性与自聚集相分离审查　·　2026-09-05 13:12:26

产物：[求解器 `mab_viscosity_B22_simulation.py`](cases/11-mab-viscosity-formulation/mab_viscosity_B22_simulation.py)

---

### 12. tci thiol trojan
> 题目：靶向共价抑制剂（TCI）的二次活化与亲电弹头“跨室相移”竞争（药物化学与反应动力学）　·　2026-09-05 13:35:55

产物：[报告 `report.md`](cases/12-tci-thiol-trojan/report.md) · [图 `tci_fig5_trojan_retention.png`](cases/12-tci-thiol-trojan/tci_fig5_trojan_retention.png) · [数据 `tci_model_summary.csv`](cases/12-tci-thiol-trojan/tci_model_summary.csv) · [求解器 `tci_thiol_exchange_kinetics.py`](cases/12-tci-thiol-trojan/tci_thiol_exchange_kinetics.py) · [图 `tci_timeseries.png`](cases/12-tci-thiol-trojan/tci_timeseries.png)

<p align="center"><img src="shots/50-tci-session.png" alt="session 12-tci-thiol-trojan" width="820" /></p>
<p align="center"><img src="cases/12-tci-thiol-trojan/tci_fig5_trojan_retention.png" alt="artifact tci_fig5_trojan_retention.png" width="820" /></p>
<p align="center"><img src="cases/12-tci-thiol-trojan/tci_timeseries.png" alt="artifact tci_timeseries.png" width="820" /></p>
---

### 13. mrna lnp endosomal
> 题目：mRNA-LNP 复杂制剂的跨相转变、内体逃逸“几何受阻”与刚性膜熔合悖论（生物物理与纳米流体）　·　2026-09-05 14:03:10

产物：[图 `fig1_geometry_packing_vs_pH.png`](cases/13-mrna-lnp-endosomal/fig1_geometry_packing_vs_pH.png) · [图 `fig3_fusion_barrier_landscape.png`](cases/13-mrna-lnp-endosomal/fig3_fusion_barrier_landscape.png) · [求解器 `lnp_endosomal_escape_thermodynamics.py`](cases/13-mrna-lnp-endosomal/lnp_endosomal_escape_thermodynamics.py) · [报告 `report.md`](cases/13-mrna-lnp-endosomal/report.md) · [数据 `table_formulation_metrics.csv`](cases/13-mrna-lnp-endosomal/table_formulation_metrics.csv) · [数据 `table_packing_parameter.csv`](cases/13-mrna-lnp-endosomal/table_packing_parameter.csv) · [数据 `table_ph_sweep.csv`](cases/13-mrna-lnp-endosomal/table_ph_sweep.csv)

<p align="center"><img src="cases/13-mrna-lnp-endosomal/fig3_fusion_barrier_landscape.png" alt="artifact fig3_fusion_barrier_landscape.png" width="820" /></p>
---

### 14. crispr epigenetic spreading
> 题目：合成表观遗传学：CRISPR-dCas9 靶向 DNA 甲基化编辑中的“表观连锁漂移”与非靶向染色质塌陷（表观基因组学与非平衡态物理）　·　2026-09-05 15:03:05

产物：[求解器 `epigenetic_spreading_lattice_sim.py`](cases/14-crispr-epigenetic-spreading/epigenetic_spreading_lattice_sim.py) · [报告 `report.md`](cases/14-crispr-epigenetic-spreading/report.md) · [数据 `simulation_metrics.json`](cases/14-crispr-epigenetic-spreading/simulation_metrics.json)

---

## Wave 2 · 非平衡动力学与活体系统（09-05 下半）

### 15. tpd futile ubiquitination
> 题目：类泛素化（PROTAC/分子胶）系统的非热力学稳态耗散与“无益泛素链（Futile Polyubiquitination）”动力学塌陷　·　2026-09-05 15:50:17

产物：[图 `fig1_degradation_heatmap.png`](cases/15-tpd-futile-ubiquitination/fig1_degradation_heatmap.png) · [图 `fig2_chain_species_timecourse.png`](cases/15-tpd-futile-ubiquitination/fig2_chain_species_timecourse.png) · [报告 `report.md`](cases/15-tpd-futile-ubiquitination/report.md) · [求解器 `tpd_ubiquitination_futile_cycle.py`](cases/15-tpd-futile-ubiquitination/tpd_ubiquitination_futile_cycle.py)

<p align="center"><img src="shots/48-tpd-session.png" alt="session 15-tpd-futile-ubiquitination" width="820" /></p>
<p align="center"><img src="cases/15-tpd-futile-ubiquitination/fig1_degradation_heatmap.png" alt="artifact fig1_degradation_heatmap.png" width="820" /></p>
---

### 16. repressilator host load
> 题目：合成生物学基因振荡器的非线性相空间失稳与“转录代谢负载（Metabolic Load）”引发的混沌塌陷　·　2026-09-05 18:21:18

产物：[数据 `lyapunov_scan.json`](cases/16-repressilator-host-load/lyapunov_scan.json) · [数据 `regime_scan.json`](cases/16-repressilator-host-load/regime_scan.json) · [报告 `report.md`](cases/16-repressilator-host-load/report.md) · [求解器 `repressilator_metabolic_load_sim.py`](cases/16-repressilator-host-load/repressilator_metabolic_load_sim.py)

---

### 17. cart immune synapse
> 题目：CAR-T / 双特异性抗体的抗原低密度“触碰即跑（Hit-and-Run）”与机械力转导门控失效　·　2026-09-05 19:08:12

产物：[图 `fig1_signal_output_phase_diagram.png`](cases/17-cart-immune-synapse/fig1_signal_output_phase_diagram.png) · [图 `fig2_residence_and_serial_killing.png`](cases/17-cart-immune-synapse/fig2_residence_and_serial_killing.png) · [求解器 `immune_synapse_mechanobiology_sim.py`](cases/17-cart-immune-synapse/immune_synapse_mechanobiology_sim.py) · [报告 `report.md`](cases/17-cart-immune-synapse/report.md)

<p align="center"><img src="cases/17-cart-immune-synapse/fig1_signal_output_phase_diagram.png" alt="artifact fig1_signal_output_phase_diagram.png" width="820" /></p>
---

### 18. lyophilization subtg
> 题目：高分子/冷冻干燥制剂中的“反玻璃化（Devitrification）”与水合壳微观渗流塌陷（软物质物理与玻璃态转变动力学）　·　2026-09-05 21:03:28

产物：[图 `fig3_percolation_crossing.png`](cases/18-lyophilization-subtg/fig3_percolation_crossing.png) · [图 `fig5_msd.png`](cases/18-lyophilization-subtg/fig5_msd.png) · [求解器 `lyophilization_devitrification_kinetics.py`](cases/18-lyophilization-subtg/lyophilization_devitrification_kinetics.py) · [报告 `report.md`](cases/18-lyophilization-subtg/report.md) · [说明 `sim_summary.txt`](cases/18-lyophilization-subtg/sim_summary.txt)

<p align="center"><img src="shots/54-lyo-session.png" alt="session 18-lyophilization-subtg" width="820" /></p>
<p align="center"><img src="cases/18-lyophilization-subtg/fig3_percolation_crossing.png" alt="artifact fig3_percolation_crossing.png" width="820" /></p>
---

### 19. bacteria cheater evolution
> 题目：溶瘤病毒/工程菌肿瘤递送中的“自私突变体（Cheater Dynamics）”生态反噬与群体感应失效（演化博弈论与合成生态学）　·　2026-09-05 21:21:47

产物：[求解器 `cheater_evolution_spatial_sim.py`](cases/19-bacteria-cheater-evolution/cheater_evolution_spatial_sim.py) · [图 `fig2_dose_pulse_decay.png`](cases/19-bacteria-cheater-evolution/fig2_dose_pulse_decay.png) · [图 `fig3_spatial_phase.png`](cases/19-bacteria-cheater-evolution/fig3_spatial_phase.png) · [报告 `report.md`](cases/19-bacteria-cheater-evolution/report.md) · [数据 `summary_statistics.json`](cases/19-bacteria-cheater-evolution/summary_statistics.json)

<p align="center"><img src="shots/52-cheater-session.png" alt="session 19-bacteria-cheater-evolution" width="820" /></p>
<p align="center"><img src="cases/19-bacteria-cheater-evolution/fig3_spatial_phase.png" alt="artifact fig3_spatial_phase.png" width="820" /></p>
---

### 20. bnab epistasis rigidity
> 题目：抗体亲和力成熟与定向进化中的“上位性冻结（Epistatic Freezing）”与免疫受体构象熵陷阱（结构免疫学与适应度地形分析）　·　2026-09-05 22:10:16

产物：[求解器 `antibody_epistasis_landscape_sim.py`](cases/20-bnab-epistasis-rigidity/antibody_epistasis_landscape_sim.py) · [图 `fig2_epistasis_landscape.png`](cases/20-bnab-epistasis-rigidity/fig2_epistasis_landscape.png) · [图 `fig3_breadth_titers.png`](cases/20-bnab-epistasis-rigidity/fig3_breadth_titers.png) · [数据 `report_numbers.json`](cases/20-bnab-epistasis-rigidity/report_numbers.json) · [数据 `summary.json`](cases/20-bnab-epistasis-rigidity/summary.json) · [数据 `variant_table.csv`](cases/20-bnab-epistasis-rigidity/variant_table.csv)

<p align="center"><img src="shots/56-bnab-session.png" alt="session 20-bnab-epistasis-rigidity" width="820" /></p>
<p align="center"><img src="cases/20-bnab-epistasis-rigidity/fig2_epistasis_landscape.png" alt="artifact fig2_epistasis_landscape.png" width="820" /></p>
---

### 21. rna small molecule polyelectrolyte
> 题目：RNA 靶向小分子（rSM）的“构象诱导折叠与动态隐匿口袋”热力学悖论与选择性崩塌　·　2026-09-05 23:16:35

产物：[图 `fig1_ion_release_fraction_phase.png`](cases/21-rna-small-molecule-polyelectrolyte/fig1_ion_release_fraction_phase.png) · [图 `fig3_ontarget_fraction_collapse.png`](cases/21-rna-small-molecule-polyelectrolyte/fig3_ontarget_fraction_collapse.png) · [报告 `report.md`](cases/21-rna-small-molecule-polyelectrolyte/report.md) · [求解器 `rsm_rna_conformation_trap_sim.py`](cases/21-rna-small-molecule-polyelectrolyte/rsm_rna_conformation_trap_sim.py) · [数据 `rsm_sim_summary.json`](cases/21-rna-small-molecule-polyelectrolyte/rsm_sim_summary.json)

<p align="center"><img src="cases/21-rna-small-molecule-polyelectrolyte/fig3_ontarget_fraction_collapse.png" alt="artifact fig3_ontarget_fraction_collapse.png" width="820" /></p>
---

### 22. antibody dcp cold reversal
> 题目：抗体-抗原识别界面的微观流变学、水分子桥滞留与低温亲和力反转（物理化学与抗体工程）　·　2026-09-05 23:46:29

产物：[求解器 `antibody_dcp_thermodynamics_sim.py`](cases/22-antibody-dcp-cold-reversal/antibody_dcp_thermodynamics_sim.py) · [图 `fig2_vantoff_deviation.png`](cases/22-antibody-dcp-cold-reversal/fig2_vantoff_deviation.png) · [图 `fig3_affinity_phase.png`](cases/22-antibody-dcp-cold-reversal/fig3_affinity_phase.png) · [报告 `report.md`](cases/22-antibody-dcp-cold-reversal/report.md) · [说明 `sim_summary.txt`](cases/22-antibody-dcp-cold-reversal/sim_summary.txt)

<p align="center"><img src="cases/22-antibody-dcp-cold-reversal/fig2_vantoff_deviation.png" alt="artifact fig2_vantoff_deviation.png" width="820" /></p>
---

### 23. supramolecular prodrug shear
> 题目：靶向实体瘤的纳米前药/多肽自组装：动态超分子聚合物的“流体剪切诱导相分离解聚与非稳态外溢”　·　2026-09-06 00:58:34

产物：[报告 `report.md`](cases/23-supramolecular-prodrug-shear/report.md) · [求解器 `supramolecular_prodrug_shear_flow_sim.py`](cases/23-supramolecular-prodrug-shear/supramolecular_prodrug_shear_flow_sim.py)

---

## Wave 3 · 结构生成与递送物理（09-06）

### 24. tnik paralog selectivity
> 题目：TNIK 伪选择性与 STE20 家族（MINK1/MAP4K4）激酶组“几何逃逸”生成反思（考核：亚型激酶选择性、变构口袋与分子生成对抗）　·　2026-09-06 10:25:30

产物：[图 `fig1_microenv_diff_matrix.png`](cases/24-tnik-paralog-selectivity/fig1_microenv_diff_matrix.png) · [图 `fig2_ploop_static_bias.png`](cases/24-tnik-paralog-selectivity/fig2_ploop_static_bias.png) · [报告 `report.md`](cases/24-tnik-paralog-selectivity/report.md) · [求解器 `tnik_kinase_selectivity_generative_audit.py`](cases/24-tnik-paralog-selectivity/tnik_kinase_selectivity_generative_audit.py)

<p align="center"><img src="shots/14-tnik-session.png" alt="session 24-tnik-paralog-selectivity" width="820" /></p>
<p align="center"><img src="cases/24-tnik-paralog-selectivity/fig2_ploop_static_bias.png" alt="artifact fig2_ploop_static_bias.png" width="820" /></p>
---

### 25. generative retrosynthesis audit
> 题目：反向合成路径（Retrosynthesis）硬约束下的“类药空间（Lipinski / QED）与靶向三维互补”多目标博弈崩溃（算法物理与分子生成逻辑）　·　2026-09-06 11:08:41

产物：[数据 `audit_results.json`](cases/25-generative-retrosynthesis-audit/audit_results.json) · [求解器 `generative_molecule_reality_audit.py`](cases/25-generative-retrosynthesis-audit/generative_molecule_reality_audit.py) · [报告 `report.md`](cases/25-generative-retrosynthesis-audit/report.md)

---

### 26. tnik scaffold wnt
> 题目：Wnt/β-catenin 轴向转录抑制中的“TNIK-TCF4-β-catenin”三元核复合物解离动力学（系统药理学与转录凝聚物）　·　2026-09-06 12:27:46

产物：[求解器 `tnik_scaffold_transcription_sim.py`](cases/26-tnik-scaffold-wnt/tnik_scaffold_transcription_sim.py)

---

### 27. bbb tfr transcytosis
> 题目：跨血脑屏障（BBB）受体介导转运（RMT）的双特异性抗体“转胞吞受阻与内皮溶酶体滞留陷阱”　·　2026-09-06 14:24:04

产物：[求解器 `bbb_tfr_transcytosis_dynamics_sim.py`](cases/27-bbb-tfr-transcytosis/bbb_tfr_transcytosis_dynamics_sim.py) · [图 `fig3_affinity_dose_phase_diagram_3d.png`](cases/27-bbb-tfr-transcytosis/fig3_affinity_dose_phase_diagram_3d.png) · [图 `fig4_endosomal_sorting_fate_incinerator.png`](cases/27-bbb-tfr-transcytosis/fig4_endosomal_sorting_fate_incinerator.png) · [数据 `sensitivity_analysis.json`](cases/27-bbb-tfr-transcytosis/sensitivity_analysis.json) · [数据 `summary_results.json`](cases/27-bbb-tfr-transcytosis/summary_results.json)

<p align="center"><img src="shots/42-bbb-session.png" alt="session 27-bbb-tfr-transcytosis" width="820" /></p>
<p align="center"><img src="cases/27-bbb-tfr-transcytosis/fig3_affinity_dose_phase_diagram_3d.png" alt="artifact fig3_affinity_dose_phase_diagram_3d.png" width="820" /></p>
---

### 28. protac invivo qsp rebound
> 题目：PROTAC / 分子胶在活体内的“Hook-Target 反向积累与耐药克隆竞争性扩增”非稳态 QSP 模拟　·　2026-09-06 15:05:49

产物：[图 `fig2_qd_oscillation_rebound.png`](cases/28-protac-invivo-qsp-rebound/fig2_qd_oscillation_rebound.png) · [图 `fig3_regimen_tumor_resistance.png`](cases/28-protac-invivo-qsp-rebound/fig3_regimen_tumor_resistance.png) · [求解器 `protac_in_vivo_qsp_feedback_sim.py`](cases/28-protac-invivo-qsp-rebound/protac_in_vivo_qsp_feedback_sim.py) · [数据 `protac_qsp_summary.json`](cases/28-protac-invivo-qsp-rebound/protac_qsp_summary.json) · [报告 `report.md`](cases/28-protac-invivo-qsp-rebound/report.md)

<p align="center"><img src="shots/44-protac-qsp-session.png" alt="session 28-protac-invivo-qsp-rebound" width="820" /></p>
<p align="center"><img src="cases/28-protac-invivo-qsp-rebound/fig2_qd_oscillation_rebound.png" alt="artifact fig2_qd_oscillation_rebound.png" width="820" /></p>
---

### 29. adc multiscale barrier
> 题目：抗体药物偶联物（ADC）在多细胞实体瘤中的“固相扩散屏障、胞饮再循环与局部微血管坏死自限性”多尺度连续统模型　·　2026-09-06 16:31:26

产物：[求解器 `adc_multiscale_biotransport_barrier_sim.py`](cases/29-adc-multiscale-barrier/adc_multiscale_biotransport_barrier_sim.py) · [图 `fig01_conc_contour_168h.png`](cases/29-adc-multiscale-barrier/fig01_conc_contour_168h.png) · [图 `fig02_survival_heatmap_168h.png`](cases/29-adc-multiscale-barrier/fig02_survival_heatmap_168h.png) · [报告 `report.md`](cases/29-adc-multiscale-barrier/report.md)

<p align="center"><img src="shots/16-adc-session.png" alt="session 29-adc-multiscale-barrier" width="820" /></p>
<p align="center"><img src="cases/29-adc-multiscale-barrier/fig01_conc_contour_168h.png" alt="artifact fig01_conc_contour_168h.png" width="820" /></p>
---

### 30. llps condensate gelation
> 题目：凝聚体靶向相分离药物（LLPS Condensate-Targeted Drug）的“临界分配塌陷与超分子免疫级联逃逸”　·　2026-09-06 17:42:13

产物：[数据 `dose_response.csv`](cases/30-llps-condensate-gelation/dose_response.csv) · [图 `fig_curing_heatmaps.png`](cases/30-llps-condensate-gelation/fig_curing_heatmaps.png) · [图 `fig_thermo_phase_diagram.png`](cases/30-llps-condensate-gelation/fig_thermo_phase_diagram.png) · [求解器 `llps_condensate_phase_transition_sim.py`](cases/30-llps-condensate-gelation/llps_condensate_phase_transition_sim.py) · [归档(字节一致) `report.md.gz`](cases/30-llps-condensate-gelation/report.md.gz) · [数据 `simulation_diagnostics.json`](cases/30-llps-condensate-gelation/simulation_diagnostics.json)

<p align="center"><img src="shots/12-llps-session.png" alt="session 30-llps-condensate-gelation" width="820" /></p>
<p align="center"><img src="cases/30-llps-condensate-gelation/fig_thermo_phase_diagram.png" alt="artifact fig_thermo_phase_diagram.png" width="820" /></p>
---
