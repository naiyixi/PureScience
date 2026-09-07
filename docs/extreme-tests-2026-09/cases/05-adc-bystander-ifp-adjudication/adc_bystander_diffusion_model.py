#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
adc_bystander_diffusion_model.py
================================
T-DM1 vs T-DXd 旁观者效应：载荷瘤内被动扩散与胞内清除竞争的机理示意图模型
(Mechanistic SCHEMATIC model; every non-database number is an explicit assumption)

物理内核 (physics core)
----------------------
稳态球对称反应-扩散方程 (steady-state spherical reaction-diffusion):

    D * (1/r^2) d/dr ( r^2 dC/dr ) - k_clr * C = 0      (r >= a)

释放载荷的 HER2+ 源细胞半径 a；间质中载荷浓度：

    C(r) = C0 * (a/r) * exp[-(r-a)/lambda],
    lambda = sqrt(D/k_clr)    (穿透长度, penetration length)
    t1/2   = ln2 / k_clr      (载荷在间质中的表观半衰期)

旁观者杀伤半径 R_kill 定义为 C(R_kill)/C0 = ER/ratio 处,
其中 ratio = C0/C_kill (源表面浓度/杀伤阈值), ER = 旁观者细胞外排放大倍数
(ER>1: 该 Ag- 细胞为 P-gp 高表达, 需要 ER 倍高的间质浓度才能达到杀伤性胞内浓度,
因此对"该耐药细胞"的杀伤半径缩短)。

k_clr = k_reuptake_trap + k_metab + k_washout
  - k_reuptake_trap : 邻近细胞摄取/胞内“汇”(微管、拓扑异构酶等结合位点捕获)
  - k_metab         : 酯酶/酰胺酶代谢、游离巯基失活(如 DM1-SH 的 S-甲基化/氧化)
  - k_washout       : 血管对流清除(高 IFP/坏死核心区小, 富灌注边缘大)

实测锚点 (retrieved anchors, 见报告)
-----------------------------------
  DM1 (mertansine)      PubChem CID 11343137  MW 738.3  XLogP 2.2  TPSA 157  ChEMBL ALogP 3.83
  DXd (released)        PubChem CID 117888634 MW 493.5  XLogP 0.0  TPSA 129  实测 logD(pH7.4)=2.3  PMID 27166974
  Lys-MCC-DM1 (T-DM1)                         实测 logD(pH7.4)=0.2, PAMPA Peff 最低  PMID 27166974
  DXd 为 P-gp/BCRP/OATP 底物 PMID 30351177; ABCB1/ABCG2 驱动 T-DXd 耐药 PMID 41548044

用法:  python adc_bystander_diffusion_model.py [--outdir PATH]
输出:  bystander_diffusion_model.png (两面板示意图) + bystander_model_assumptions.json
"""
import argparse, json, math
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ----------------------------------------------------------------------
# 模型输入 (全部为示意性假设, 详见报告 Data Gap 部分)
# ----------------------------------------------------------------------
DEFAULT = dict(
    r0_um=6.0,      # 释放载荷的 HER2+ 源细胞半径 (μm)
    D_cm2s=3.0e-7,  # 间质有效扩散系数 (~500 Da 小分子在肿瘤间质, 量级 1e-7~1e-6 cm^2/s)
    ratio=100.0,    # C0/C_kill : 源表面浓度/旁观者杀伤阈值 (示意值, 2 个对数单位)
    ER=4.0,         # Ag- 旁观者细胞为 P-gp 高表达时的外排放大倍数 (示意值)
)
COMPARTMENTS = {   # k (s^-1); t1/2 = ln2/k
    "k_reuptake_trap (邻近细胞摄取/胞内汇)": 3.85e-3,   # ~3  min
    "k_metab (代谢/游离巯基失活)":             5.8e-4,   # ~20 min
    "k_washout (血管对流; 高IFP区低)":         1.9e-4,   # ~60 min
}
D_SCEN = {  # 不同间质致密程度的扩散系数情景 (cm^2/s)
    "dense/high-IFP, D=1e-7": 1e-7,
    "mid, D=3e-7":            3e-7,
    "loose, D=1e-6":          1e-6,
}

def lambda_pen(D_cm2s, thalf_min):
    """穿透长度 lambda = sqrt(D/k), k = ln2/t1/2   (cm)."""
    k = math.log(2) / (thalf_min * 60.0)
    return math.sqrt(D_cm2s / k)

def kill_radius_um(D_cm2s, thalf_min, r0_um, ratio, ER=1.0):
    """求 C(r)/C0 = ER/ratio 处的半径 (bisection; C 随 r 单调下降)."""
    a_cm = r0_um * 1e-4
    lam_cm = lambda_pen(D_cm2s, thalf_min)
    cgoal = ER / ratio
    lo, hi = a_cm, max(a_cm * ratio / ER, a_cm * 1.001)
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        f = (a_cm / mid) * math.exp(-(mid - a_cm) / lam_cm) - cgoal
        if f > 0:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi) * 1e4  # μm

def radial_profile(r_um, D_cm2s, thalf_min, r0_um):
    a, r = r0_um * 1e-4, np.asarray(r_um, float) * 1e-4
    lam = lambda_pen(D_cm2s, thalf_min)
    return np.where(r > 0, (a / r) * np.exp(-(r - a) / lam), 1.0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()

    k_tot = sum(COMPARTMENTS.values())
    t12 = math.log(2) / k_tot / 60.0
    lam = lambda_pen(DEFAULT["D_cm2s"], t12)
    r_base = kill_radius_um(DEFAULT["D_cm2s"], t12, DEFAULT["r0_um"], DEFAULT["ratio"])
    r_er = kill_radius_um(DEFAULT["D_cm2s"], t12, DEFAULT["r0_um"], DEFAULT["ratio"], DEFAULT["ER"])
    print("k_total=%.4g s^-1 -> 间质载荷 t1/2=%.1f min" % (k_tot, t12))
    print("lambda=%.0f μm ; 旁观者杀伤半径=%.0f μm (Ag-敏感) ; P-gp(高)旁观者(ER=%.0f): %.0f μm"
          % (lam * 1e4, r_base, DEFAULT["ER"], r_er))

    thalf = np.logspace(0, 2.1, 90)
    R = {k: np.array([kill_radius_um(d, t, DEFAULT["r0_um"], DEFAULT["ratio"])
                      for t in thalf]) for k, d in D_SCEN.items()}
    R_ER = np.array([kill_radius_um(DEFAULT["D_cm2s"], t, DEFAULT["r0_um"],
                                    DEFAULT["ratio"], DEFAULT["ER"]) for t in thalf])

    rr = np.linspace(6, 420, 800)
    prof_fast = radial_profile(rr, 3e-7, 3.0, 6.0)
    prof_slow = radial_profile(rr, 3e-7, 30.0, 6.0)
    prof_none = 6.0 / np.maximum(rr, 1e-9)

    c_fast, c_slow = "#0e7c7b", "#6a3d9a"
    c_mid, c_dense, c_loose, c_grey = "#2b6cb0", "#8c2d04", "#1a7f37", "#9e9e9e"
    fig, (axA, axB) = plt.subplots(1, 2, figsize=(12.4, 5.0))
    thr = 1.0 / DEFAULT["ratio"]

    # Panel A: 径向浓度剖面
    axA.plot(rr, prof_none, color=c_grey, ls="--", lw=1.4,
             label="无清除 (纯 1/r 几何稀释)")
    axA.plot(rr, prof_fast, color=c_fast, lw=2.2,
             label="胞内清除快 (t½=3 min)")
    axA.plot(rr, prof_slow, color=c_slow, lw=2.2,
             label="胞内清除慢 (t½=30 min)")
    axA.axhline(thr, color="k", lw=1.0, ls=":", alpha=0.85)
    axA.text(300, thr * 1.5, "旁观者杀伤阈值\nC/C0 = 1/%.0f (示意)" % DEFAULT["ratio"],
             fontsize=8, ha="right")
    axA.axvspan(0, 6, color="0.75", alpha=0.35)
    axA.text(4.5, 0.75, "源细胞", ha="right", fontsize=8, color="0.2")
    for t, c in ((3.0, c_fast), (30.0, c_slow)):
        rk = kill_radius_um(3e-7, t, 6.0, DEFAULT["ratio"])
        axA.plot([rk, rk], [0, thr], color=c, lw=1.1)
        axA.text(rk, thr * 1.6, "R≈%.0f μm" % rk, color=c, fontsize=9, ha="center")
    axA.set_xlabel("距释放细胞的径向距离 (μm)")
    axA.set_ylabel("间质载荷浓度 C/C0 (对数)")
    axA.set_yscale("log"); axA.set_xlim(0, 420); axA.set_ylim(1e-3, 1.5)
    axA.set_title("A  被动径向扩散 vs 清除竞争", fontsize=10)
    axA.grid(alpha=0.25, which="both"); axA.legend(fontsize=7.5, loc="upper right", framealpha=0.9)

    # Panel B: 杀伤半径 vs 胞内清除半衰期
    axB.plot(thalf, R["dense/high-IFP, D=1e-7"], color=c_dense, lw=2.0,
             label="D = 1×10⁻⁷ cm²/s — 致密/高 IFP")
    axB.plot(thalf, R["loose, D=1e-6"], color=c_loose, lw=2.0,
             label="D = 1×10⁻⁶ cm²/s — 疏松/低 IFP")
    axB.plot(thalf, R["mid, D=3e-7"], color=c_mid, lw=1.6,
             label="D = 3×10⁻⁷ cm²/s")
    axB.plot(thalf, R_ER, color="#c1121f", lw=2.0, ls="--",
             label="Ag⁻ 旁观者为 P-gp(高): 需 ×ER=%.0f 间质浓度" % DEFAULT["ER"])
    axB.axhline(DEFAULT["r0_um"], color="0.3", lw=1.0, ls=":")
    axB.text(1.25, DEFAULT["r0_um"] * 1.9,
             "≈一个细胞直径 — 不可通透带电代谢物\n(Lys-MCC-DM1): 无旁观者效应", fontsize=7.5, color="0.25")
    axB.set_xscale("log")
    axB.set_xlabel("间质载荷清除半衰期 t½ (min)   [清除越快 → 左侧]")
    axB.set_ylabel("有效旁观者杀伤半径 (μm)")
    axB.set_title("B  旁观者杀伤半径 vs 胞内清除竞争", fontsize=10)
    axB.grid(alpha=0.3, which="both"); axB.legend(fontsize=7.5, loc="lower right", framealpha=0.92)
    axB.annotate("快速捕获/清除 → 短程", xy=(2.6, 55), fontsize=8, color="0.2",
                 arrowprops=dict(arrowstyle="->", color="0.4"))
    axB.annotate("慢清除 → 长程, 但间质外逸入血 →\n全身/正常组织暴露(如肺)与洗脱",
                 xy=(55, 420), fontsize=8, color="0.2",
                 arrowprops=dict(arrowstyle="->", color="0.4"))
    fig.suptitle("ADC 旁观者载荷: 间质扩散–清除竞争 (机理示意图; 参数为假设 — 见报告)",
                 fontsize=9.5, y=0.99)
    fig.tight_layout(rect=[0, 0, 1, 0.94])
    png = args.outdir.rstrip("/") + "/bystander_diffusion_model.png"
    fig.savefig(png, dpi=160)

    out = dict(DEFAULT=DEFAULT, compartments=COMPARTMENTS, k_total_per_s=k_tot,
               t_half_total_min=t12, lambda_um=lam * 1e4,
               kill_radius_um_base=r_base, kill_radius_um_ER4=r_er)
    with open(args.outdir.rstrip("/") + "/bystander_model_assumptions.json", "w") as fh:
        json.dump(out, fh, indent=1)
    print("saved:", png)
    print("示例半径 (μm) @t½=3,10,30 min, D=3e-7:",
          [round(kill_radius_um(3e-7, t, 6, DEFAULT["ratio"]), 1) for t in (3, 10, 30)])

if __name__ == "__main__":
    main()
