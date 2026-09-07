# 高亲和力 ADC 瘤内血管周屏障与物理隔离复发机制裁决研报

**裁决对象（对抗性临床开发假说）**
某团队主张：一款针对实体瘤高表达受体（HER2 / Trop‑2）的“重锤型”ADC——
皮摩尔级超高亲和力单抗（Kd = 10 pM）+ 拓扑异构酶 I 抑制剂载荷（DAR = 8，
单载荷 IC50 < 0.1 nM），在低全身暴露剂量下即可实现“每个 ADC 分子被肿瘤细胞
牢牢抓住并内吞杀伤”，从而 **一击必杀、彻底清除实体瘤深层病灶、不遗留瘤内
耐药/耐药性微区**。

**本报告结论（先行给出）**：该假说在非线性反应–扩散传输物理上被否决。
结合位点屏障把**自由抗体的有效捕获长度**锁定在血管壁外 ~2 个细胞直径（~≤20 µm），
并把**直接内吞杀伤可达深度**限制在 ~90 µm（72 h 单剂量）之内；同时，超高效载荷
造成的**血管周第一层同步坏死**在给药后 ~20 h 即触发局灶微血栓 + 机械塌陷（血管自毁），
其中 **10 pM 抗体因 k_off≈1e-6 s⁻¹ 而永久“镀”在坏死残骸上，形成不可再通的慢性闭塞**，
使后续批次/轮次的血液灌注被物理切断；深部（>200 µm）细胞处于“药理性物理隔离
避难所”，必然残留并复发。作为对照的 **5 nM 平衡亲和力臂**因解离-再渗透（k_off 高
~500 倍）把内吞载荷分发到更深、且其血管周沉积物可在疗程间洗脱再通，四轮 Q3W 后把
可及区清至 ~7% 残留。结论：**亲和力不是越高越好；“超高亲和力 × 超高效载荷”的组合
反而因屏障 + 血管自毁成为最不利于深层清除的方案之一。**

---

## 0. 交付物

| 交付物 | 文件 |
|---|---|
| 主脚本（多尺度连续统求解器） | `adc_multiscale_biotransport_barrier_sim.py` |
| 图 1：径向–时间药物浓度等高线（168 h 单剂量） | `fig01_conc_contour_168h.png` |
| 图 2：径向–时间细胞存活率热图（168 h 单剂量） | `fig02_survival_heatmap_168h.png` |
| 图 3：微血管通畅率/残留病灶随治疗轮次退化 | `fig03_patency_residual_vs_rounds.png` |
| 原始结果（可复现） | `results_high.npz`, `results_med.npz` |
| 本研报 | 本文件 |

复现：`python adc_multiscale_biotransport_barrier_sim.py --case high --outdir .`
及 `--case med`（每臂完整 4 轮约需数分钟）。数值环境：Python 3.12, numpy/scipy/matplotlib。

---

## 1. 从反应–扩散物理驳斥：结合位点屏障把有效穿透钉死在血管周

### 1.1 捕获长度：为什么 Kd=10 pM + 高抗原丰度把自由抗体锁在 ≤ ~20 µm

在 Krogh 筒几何下，自由 ADC（浓度 $C$)沿径向的稳态方程为

$$\underbrace{\frac{1}{r}\frac{d}{dr}\Big(r D_{\text{eff}}\frac{dC}{dr}\Big)}_{\text{弥散}}
\;-\;\underbrace{k_{\rm on}\,B\,C}_{\text{抗原捕获}}
\;-\;\underbrace{k_{\rm int}\frac{k_{\rm on}}{k_{\rm off}+k_{\rm int}}\,B\,C}_{\text{结合后内吞消耗}}
\;-\;k_{\rm cl}\,C\;=\;0$$

其中 $B$ = 组织体积内可结合抗原当量浓度。对 **HER2 ≈ 2×10⁶ 拷贝/细胞、致密实体瘤
~3×10⁸ 细胞/mL**：$B_0 ≈ 1\,\mu$M。对 10 pM 抗体，$k_{\rm off}=k_{\rm on}K_d\approx
1\text{e}5\times10^{-11}=10^{-6}\,\text{s}^{-1}\ll k_{\rm int}=2\times10^{-4}\,\text{s}^{-1}$，
即**结合后几乎不可逆、随即内吞被消耗** ⇒ 有效捕获（一级）速率
$\kappa\approx k_{\rm on}B_0\approx 0.1\,\text{s}^{-1}$（并在被杀细胞上以 $k_{\rm end}$
再合成抗原持续再生，形成“防火墙”）。由此定义**结合位点屏障捕获长度**：

$$\lambda \;=\;\sqrt{\dfrac{D_{\text{eff}}}{k_{\rm on}\,B_0}}
      \;\approx\; \sqrt{\dfrac{0.5\text{–}3\ \mu\text{m}^2/\text{s}}{0.1\ \text{s}^{-1}}}
      \;\approx\; 2.2\text{–}5.5\ \mu\text{m}
      \qquad(\text{取上限 }D_{\text{eff}}=8\ \mu\text{m}^2/\text{s} \Rightarrow \lambda\approx 9\ \mu\text{m})$$

即自由抗体在离管壁第 1–2 层细胞内就被**不可逆捕获并内吞**，剩余可扩散的自由部分
指数衰减。这是经典“结合位点屏障”的定量内核（van Osdol 1991; Juweid 1992; Thurber &
Wittrup 2008; 综述 Jain 1987; Thurber 2008）。

**本模型的直接读数（72 h）**：自由 ADC 的 e 折衰减长度 $\lambda_F\approx 19\ \mu$m
（≈1–2 个细胞直径），与解析 $\lambda$ 同量级；因此**自由（可继续扩散杀伤的）药物
从未越出管壁外 ~2 个细胞直径的环带**。总结合量（F+Ab+Abi）之所以在数十 µm 仍有可观值，
是“饱和–波前”与旁观者效应叠加的结果，并非自由药能穿透——后者才是驱动复发微区形成的物理边界。

### 1.2 亲和力“天花板”：k_off 决定能否解离–跳跃渗透

把 5 nM（$k_{\rm off}=5\times10^{-4}\,\text{s}^{-1}$）与 10 pM（$k_{\rm off}=10^{-6}$）
在同一 $k_{\rm on}$、同一内吞率下比较：每次结合后被内吞消灭的概率约为
$k_{\rm int}/(k_{\rm int}+k_{\rm off})$——10 pM 时 **≈100%**（第一层即“消费”该分子），
5 nM 时 ≈29%，剩余分子解离后可再扩散到下一层。因此 5 nM 分子在被内吞前平均“跳”约 3–4 层，
把内吞载荷分发到更深处。这正是实验上**中低亲和力穿透更好、超高亲和力只增加血管周滞留**的
“亲和力天花板”效应（Adams 2001; Rudnick & Adams 2009）在本模型中的涌现。

模型定量（72 h，单剂量）：10 pM 臂在 150 µm 处内吞池 $A_{bi}\approx1.9\times10^{-8}\,\mu$M，
5 nM 臂 $3.9\times10^{-6}\,\mu$M（**高 200×**）；在 200 µm 处相差 **~1200×**。
“直接内吞载荷致死可达深度”（$A_{bi}\ge0.1$ nM）：**10 pM ≈ 88 µm vs 5 nM ≈ 111 µm**。
换言之 10 pM 并不比 5 nM “抓得更牢更多”——它只是把几乎全部载荷**压死在血管周隔室**
（0–30 µm 内吞“做功”AUC 比 5 nM 高约 13%：1.30×10⁷ vs 1.15×10⁷）。

### 1.3 “深部残留必然发生”：物理隔离而非基因耐药

图 2（单剂量存活率热图）显示：两臂在第 1 轮都把 **0–~130 µm** 的血管周可及带杀穿，
但 **>150–200 µm 区域几乎未暴露**（72 h 时 10 pM 在 200 µm 处 $A_{bi}\sim4\times10^{-11}\,\mu$M ≈ 0）。
这些深部细胞不是因为耐药突变而存活，而是因为**药物在物理上从未到达**——是一个
“药理性隔离避难所”。肿瘤任何一次分裂/再分布都可能把该微区带出可及范围，形成
**物理隔离介导的复发**；这直接否定了“不留瘤内微区残留”的子主张。

---

## 2. 超强杀伤的流体力学灾难：血管自毁（Vascular Self-sabotage）

### 2.1 机理链条

1. **第一层同步坏死**：血管周 0–20 µm 细胞因最高药物暴露、在数小时内跨过致死载荷阈值并
   **集中凋亡/坏死解离**。
2. **促凝 + 高压**：坏死解离释放组织因子/促凝磷脂与高分子碎片 → 邻近微血管内皮触发局灶
   微血栓；细胞肿胀+水肿抬高间质液压（Starling 反向）并对管腔产生**机械压迫**。
3. **管径收缩 → 灌注断路**：我们把这一损伤编码为“**急性关闭**”：
   $$P_{\rm intra}(t)=\dfrac{P_{\rm base}}{1+\big(R_{nc}(t)/R_{h}\big)^{s}},\qquad
   R_{nc}=\text{本轮血管周新坏死分数(0–20 µm)}$$
   本模型（Rh=0.62, s=6）中两臂均在 **~20.3 h** 触发关闭（图 2 中红线），跨壁输注通量
   $\propto P_{\rm intra}$，**同一次给药后续剂量即被截断**；图 1 中高浓度带在关闭后不再向外扩展。

### 2.2 亲和力决定“能否再通”：10 pM 的慢性“镀层栓”

第 1 轮急性关闭是两臂共有的（首轮疗效几乎相同，见 3.4 节：10 pM v_end=0.764 vs 5 nM
0.754）。真正的分水岭在 14 天疗程间隙：

- **10 pM**：坏死残骸上的结合物 $k_{\rm off}\approx10^{-6}\,\text{s}^{-1}$（半衰期 ~8 天），
  14 天后仍 >50% 停留在血管口，形成**“pM‑药物镀层的坏死纤维栓”**，阻碍纤溶再通与残骸吸收。
  模型测得的间隙期末残留血管周栓量：**10 pM ≈ 0.016（量纲 µM·µm²）vs 5 nM ≈ 10⁻⁵⁰（≈ 完全清除）**。
  由此慢性通畅率逐轮崩塌：P_start = 1.00 → 0.05 → 0.02 → 0.02（图 3a 红线）。
- **5 nM**：结合物几分钟内解离、游离药被清除，残骸可被吸收 → 微血管在每轮前**再通**，
  P_start 恒为 1.00（图 3a 蓝线）。

### 2.3 慢性闭塞 → 后续轮次断供 → 复发

图 3b：10 pM 臂第 1 轮后残留可及肿瘤比例 ~0.76，因血管已慢性闭塞、2–4 轮几乎零灌注，
残留平台 **0.764 → 0.768 → 0.778 → 0.778**（不再下降），死亡前缘（v=0.5 处）**钉死在
133 µm 不再退缩**——即“坏死纤维包囊隔离 + 残留深部病灶”。这从机制上复现了团队主张
所忽略的 **“杀伤血管周 = 杀死自己的供血管”** 悖论。

---

## 3. 多尺度连续统模型

### 3.1 几何与方程（径向 Krogh 筒，1 维柱坐标）

- 单根可灌注微血管（半径 a=10 µm）→ 血管壁外 0–300 µm 组织筒，N=80（dx=3.75 µm）。
- 状态（均按组织体积，µM；活细胞按分数 v）：自由 ADC $F$、表面游离抗原 $A_g$、
  表面结合 $A_b$、内吞 $A_{bi}$、游离旁观者载荷 $Pay$、细胞内载荷 $q$（分子/细胞）、
  活/坏死分数 $v,n$。壁通量 Robin 边界 + 载荷洗出边界；小量外向 Starling 平流。

$$\partial_t F=\tfrac{1}{r}\partial_r\big(rD_F\partial_r F\big)-\nabla\cdot(\mathbf u F)
-k_{\rm on}F A_g+k_{\rm off}A_b-k_{\rm cl}F$$
$$\partial_t A_g=-k_{\rm on}F A_g+k_{\rm off}A_b-k_{\rm int}A_b+k_{\rm end}(A_{g0}v-A_g)$$
$$\partial_t A_b=k_{\rm on}F A_g-(k_{\rm off}+k_{\rm int})A_b,\qquad
\partial_t A_{bi}=k_{\rm int}A_b-k_{\rm rel}A_{bi}$$
$$\partial_t Pay=\tfrac{1}{r}\partial_r\big(rD_P\partial_r Pay\big)-\nabla\cdot(\mathbf u Pay)
+8 f_{\rm leak}k_{\rm rel}A_{bi}-(k_{P}+k_{\rm up}v)Pay$$
$$\dot q=k_{\rm rel}A_{bi}(1-f_{\rm leak})\,8\,M_{\mu M}+k_{\rm up}v\,Pay\,M_{\mu M}-k_{\rm rep}q,
\qquad \dot v=-k_{\rm kill}\,\dfrac{q^h}{q^h+L_{50}^h}\,v,\quad \dot n=-\dot v$$

### 3.2 关键参数（单位：s, µm, µM）

| 参数 | 值 | 含义 |
|---|---|---|
| $k_{\rm on}$ | 1×10⁵ M⁻¹s⁻¹ | 结合（两臂同） |
| $K_d$（high/med） | 10 pM / 5 nM → $k_{\rm off}$=1e-6 / 5e-4 s⁻¹ | 解离（唯一差异） |
| $A_{g0}$ | ~1 µM | ≈2×10⁶ HER2/细胞（3×10⁸ 细胞/mL） |
| $k_{\rm int}$ / $k_{\rm end}$ | 2e-4 / 3e-5 s⁻¹ | 内吞 / 抗原维持（表面半衰期 ~小时–天） |
| DAR / $f_{\rm leak}$ | 8 / 0.6 | 载药量 / 载荷外泄比（旁观者） |
| $L_{50},h,k_{\rm kill}$ | 1e4 分子/细胞, 4, 1.5e-5 s⁻¹ | 致死阈值 Hill（对应载荷 IC50<0.1 nM 的超高效） |
| $D_F,D_P$ | 3 / 8 µm² s⁻¹ | 组织有效扩散系数（坏死压实降 D） |
| 血浆 PK | C₀=0.4 µM, t₁/₂≈4.5 d | 3 mg/kg、150 kDa 抗体单次静注近似 |
| 血管 | $P_{\rm vas}$=4e-3 µm/s, Rh=0.62, s=6 | 透壁渗漏性 + 急性血栓/塌陷开关 |
| 疗程 | 7 d 治疗 + 14 d 间隙，4 轮 Q3W | 见图 3 |

数值方法：FV 柱坐标 + 隐式 Backward-Euler 扩散（Thomas），反应项显式自适应子步；
旁观者载荷、内吞、死亡反应齐全。完整符号/方程见脚本头部 docstring。

### 3.3 结果图

- **图 1（浓度等高线，168 h 单剂量）**：两臂在第 1 轮给药期高浓度带均限于血管周 ~数十 µm，
  且 ~20 h 急性关闭后不再外扩。5 nM 臂的径向尾部更远（10 pM 在 100 µm 处总量已 <10⁻⁴ µM，
  5 nM 高 ~2 个量级），体现“解离-跳跃渗透”。
- **图 2（存活率热图）**：两臂都把血管周 0–~130 µm 打穿，但深部（150–300 µm）**保持可活**，
  红色虚线标注急性血管关闭时刻。
- **图 3（多轮疗效与血管退化）**：10 pM 臂血管在第 1 轮后慢性闭塞（P→0.02）、
  残留 ~0.78 平台、前缘不动（复发）; 5 nM 臂每轮再通、前缘 137→287 µm 逐轮退缩，
  残留 0.75→0.15→0.07→0.07（仅极深无血管尾端保留微区，其必然复发符合“物理隔离”论断）。

### 3.4 关键定量对照表

| 指标（72 h 或各轮） | 10 pM 超高亲和力 | 5 nM 平衡亲和力 |
|---|---|---|
| 自由 ADC e 折捕获长度 λ_F | ~19 µm | ~19 µm |
| 直接内吞致死可达（A_bi≥0.1 nM，72 h） | ~88 µm | ~111 µm |
| A_bi @150 µm (72 h) | 1.9e-8 µM | 3.9e-6 µM (×200) |
| 血管周 0–30 µm 内吞做功 AUC(168 h) | 1.30e7 | 1.15e7（−13%） |
| 第 1 轮急性关闭时间 | ~20.3 h | ~20.3 h |
| 间隙期末血管周残留栓 | 0.016（不可清） | ≈0（可清） |
| P_start 各轮 | 1.00/0.05/0.02/0.02 | 1.00/1.00/1.00/1.00 |
| 残留可活（v_end 各轮） | 0.76/0.77/0.78/0.78 | 0.75/0.15/0.07/0.07 |
| 存活前缘退缩（v=0.5 处） | 133→133→133→133 µm（冻结） | 137→287→…（清空可及区） |

---

## 4. 裁决

| 假说子主张 | 裁决 | 依据 |
|---|---|---|
| 10 pM 使每个分子被牢牢捕获内吞 → 更高杀伤 | **驳回** | 首轮疗效与 5 nM 相当（0.76 vs 0.75）；内吞做功反被压缩在血管周（+13%），150 µm 处内吞池低 200× |
| 低暴露剂量即可一击必杀、清空深层 | **驳回** | 自由药捕获长度 ~2 个细胞直径；直接致死可达 ~88 µm；200–300 µm 全程零暴露；图 1/2 |
| 不留瘤内微区残留 | **驳回** | >150 µm 全程药理性隔离；10 pM 臂 ~78% 残留平台并物理隔离复发（图 3b） |
| 后续可重复给药补刀（隐含） | **驳回（10 pM）** | 血管周坏死 + pM 不可清栓 → 慢性闭塞 → 2–4 轮零灌注（图 3a）；5 nM 因可洗脱可再通 |

**裁决主文**：靶向 HER2/Trop‑2 类超高密度抗原的 “10 pM + 超高效载荷” ADC，
其结合位点屏障与“超强杀伤→血管自毁”的正反馈使其**无法**实现假说承诺的深部彻底清除；
该组合至多把一小圈血管周组织杀穿后自断血供，深部病灶以物理隔离形式存活。优化方向应转向
**平衡亲和力（低 nM 级，k_off 允许解离渗透）、控释型旁观者、以及抗血管损伤/促进再通的
给药方案与监测（血管造影/灌注成像、微环境通透性生物标志物）**。

---

## 5. 局限与可证伪性（诚实的边界声明）

1. **单血管 Krogh 筒理想化**：300 µm 深筒代表“乏血管/灌注受限”间隙的最坏情形；真实肿瘤
   由多血管单元与异质灌注构成，结果应外推为“相对倾向”而非逐例临床数值。
2. **旁观者与载荷药代**：游离载荷清除/摄取等以文献级有效参数代替；旁观者杀伤距离对结论
   的方向性不敏感（收紧后 10 pM 臂更差）。
3. **血管损伤模型**：急性血栓以“新坏死触发、Hill 开关”参数化；“pM 镀层栓不可再通 vs nM
   可再通”是本模型的一个**可检验假设**，量化为间隙期末残留血管周结合物差（10 pM ≫ 5 nM）。
   若体内显示 pM 结合物同样被快速清除/再通，则 10 pM 的劣势主要退回“穿透浅一层”，
   本报告主论断（屏障 + 深部避难所）仍成立，仅“永久闭塞”一节需弱化。
4. **体外/动物可证伪预测**：① 单克隆肿瘤球/血管周共培养中，pM ADC 的 A_bi 深度分布应明显
   浅于 nM ADC；② 多轮给药后 pM 组血管周应出现持续至多周的结合物残留与灌注下降；
   ③ 深部（>150 µm）细胞表型应为“未暴露”而非“耐药突变”，单细胞转录组应缺药物压力特征。

---

## 6. 主要参考文献（真实文献，方向性引用）

- Jain RK. Transport of molecules in the tumor interstitium: a review. *Cancer Res* 1987;47:3039.
- Fujimori K, et al. A modeling analysis of monoclonal antibody percolation through tumors: a binding-site barrier. *J Nucl Med* 1990;31:1191.
- van Osdol W, Fujimori K, Weinstein JN. An analysis of monoclonal antibody distribution in microscopic tumor nodules: consequences of a "binding site barrier". *Cancer Res* 1991;51:4776.
- Juweid M, et al. Micropharmacology of monoclonal antibodies in solid tumors: direct experimental evidence for a binding site barrier. *Cancer Res* 1992;52:5144.
- Adams GP, et al. High affinity restricts the localization and tumor penetration of single-chain Fv antibody molecules. *Cancer Res* 2001;61:4750.
- Rudnick SI, Adams GP. Affinity and avidity in antibody-based tumor targeting. *Cancer Biother Radiopharm* 2009;24:155.
- Thurber GM, et al. Antibody tumor penetration: theory and experiment. *Adv Drug Deliv Rev* 2008;60:1421.
- Thurber GM, Wittrup KD. Quantitative spatiotemporal analysis of antibody fragment diffusion and endocytic consumption in tumor spheroids. *Cancer Res* 2008;68:3334.
- Ogitani Y, et al. DS-8201a (T-DXd): bystander killing mechanism. *Clin Cancer Res* 2016;22:5097.
- Dvorak HF, et al. Fibrin and tumor stroma (fibrin deposition / coagulation in tumors). *JNCI* / *Am J Pathol* (方向性引用凝血-肿瘤微环境).
- 附注：Krogh A. 圆柱几何由 Krogh 1919 提出；Starling 渗流为其经典平衡。
