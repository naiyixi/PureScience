# -*- coding: utf-8 -*-
"""
mab_viscosity_B22_simulation.py
高浓度单克隆抗体 (mAb) 注射剂 —— 黏度"爆炸"与相互作用状态 (B22) 仿真
=====================================================================
物理图像
--------
零剪切黏度由"水动力学拥挤"决定 (Mooney 1948 / Ross-Minton 1977):
    ln(eta/eta_w) = 2.5 * phi_eff / (1 - phi_eff / phi_max)
    phi_eff(c) = c * v_bar_eff(c) / 1000 ,  c 单位 mg/mL, v_bar 单位 mL/g
瞬态自缔合通过等链(isodesmic)缔合平衡把平均缔合度 n_w 放大,
并使每个流动单元的等效水动力体积增大 (捕获溶剂/各向异性簇):
    v_bar_eff = v_bar_0 * n_w^ALPHA      (ALPHA = 3*nu - 1, nu~0.53)
分子间净吸引越强 => 有效缔合常数 K_eff 越大 (对应 B22 由微正转强负)。

三种相互作用状态 (对照):
  * 微正 B22 (静电排斥 / 强电荷-电荷斥力屏障)   -> K ~ 0   (硬球类)
  * 近零~弱负 B22 (弱瞬态自缔合)               -> K 中
  * 强负 B22 (疏水斑块/电荷斑块驱动, 强自吸引)  -> K 大  => 黏度发散+LLPS

运行:  python mab_viscosity_B22_simulation.py
输出:  figure_viscosity_explosion_B22.png + 控制台数值表
"""
import numpy as np
from scipy.optimize import brentq
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---- 全局物性 (mAb 代表性值) ---------------------------------------------
M        = 150e3      # 分子量 Da
V0       = 1.65       # mL/g 单体拟硬球水合等效比容 (硬球R_h~5nm量级的有效值)
PHI_MAX  = 0.68       # 随机密堆积体积分数
ALPHA    = 0.60       # 簇生长对等效水动力体积的指数 (alpha=3*nu-1, nu~0.53)
ETA_W    = 1.0        # 20 C 水黏度 cP (相对黏度数值即 cP)

plt.rcParams["font.sans-serif"] = ["Arial Unicode MS", "Heiti SC", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

def _y_from_A(A):
    """等链缔合 A = C_total*K => y = K*c1 in (0,1); c1 为自由单体浓度。"""
    A = np.asarray(A, float)
    y = np.empty_like(A)
    m = A > 1e-12
    y[m]  = (2*A[m] + 1 - np.sqrt(4*A[m] + 1)) / (2*A[m])
    y[~m] = A[~m]
    return y

def n_w_of(c_mgml, K):
    """浓度 c 下的重均缔合度 (等链缔合)。c_mgml/M 即摩尔浓度(mol/L)。"""
    A = c_mgml / M * K
    y = _y_from_A(A)
    return np.where(A > 0, (1 + y) / (1 - y), 1.0)

def phi_eff(c_mgml, K):
    phi0 = c_mgml * V0 / 1e3
    return phi0 * n_w_of(c_mgml, K)**ALPHA

def ln_eta(c_mgml, K):
    pe = np.minimum(phi_eff(c_mgml, K), PHI_MAX * (1 - 1e-9))
    return 2.5 * pe / (1 - pe / PHI_MAX)

def eta_cP(c_mgml, K):
    return ETA_W * np.exp(np.clip(ln_eta(c_mgml, K), None, 60))

def divergence_c(K, c_max=500):
    """phi_eff 触顶 PHI_MAX 的数学发散浓度; 无根则返回 inf。"""
    if K <= 0:
        return np.inf
    cg = np.linspace(0.1, c_max, 20000)
    v  = phi_eff(cg, K) - PHI_MAX
    idx = np.flatnonzero(v > 0)
    if idx.size == 0:
        return np.inf
    j = idx[0]
    lo = cg[j-1] if j > 0 else 0.05
    return float(brentq(lambda x: phi_eff(x, K) - PHI_MAX, lo, cg[j]))

def K_for_divergence(cstar):
    f = lambda K: phi_eff(cstar, K) - PHI_MAX
    if f(1.0) > 0:
        return brentq(f, 1e-3, 1.0)
    return brentq(f, 1.0, 5e5)

def c_at_eta(target_eta, K, c_max=500):
    """黏度首次达到 target_eta 的浓度 (实际配方操作上限)。"""
    cg = np.linspace(0.1, c_max, 20000)
    e  = eta_cP(cg, K) - target_eta
    idx = np.flatnonzero(e > 0)
    if idx.size == 0:
        return np.inf
    j = idx[0]
    lo = cg[j-1] if j > 0 else 0.05
    return float(brentq(lambda x: eta_cP(x, K) - target_eta, lo, cg[j]))

# ---- 校准: 由"发散拐点"反求等效缔合常数 K --------------------------------
K_REP    = 0.0                        # 微正 B22, 静电排斥屏障抑制缔合
K_MID    = K_for_divergence(300.0)    # 近零/弱负 B22 -> 发散在 ~300 mg/mL
K_STRONG = K_for_divergence(175.0)    # 强负 B22     -> 发散在 ~175 mg/mL

states = [("micro-+ B$_{22}$ (electrostatic repulsion)", K_REP,   "#1f77b4"),
          ("B$_{22}$ ~ 0 / weakly negative",             K_MID,    "#ff7f0e"),
          ("B$_{22}$ << 0 (strong self-attraction)",     K_STRONG, "#d62728")]

print("K_REP    = %.3g M^-1   (electrostatic repulsion / hard-sphere-like)"
      % K_REP)
print("K_MID    = %.3g M^-1   (divergence ~ %.0f mg/mL)"
      % (K_MID, divergence_c(K_MID)))
print("K_STRONG = %.3g M^-1   (divergence ~ %.0f mg/mL)"
      % (K_STRONG, divergence_c(K_STRONG)))

# ---- 数值表 ---------------------------------------------------------------
cc  = [50., 100., 150., 200., 250.]
print("\n viscosity (cP)  vs  concentration (mg/mL)")
print(" state              | " + " ".join("%7.0f" % c for c in cc) +
      " |  diverge | c(50cP)")
for name, K, col in states:
    row = " ".join("%7.0f" % min(eta_cP(c, K), 1e6) for c in cc)
    dv  = divergence_c(K)
    c50 = c_at_eta(50, K)
    print("%-19s | %s | %8.0f | %6.0f"
          % (name.split(" ")[0].replace("$","")+" "+name.split(" ")[1][:1],
             row, dv, c50))

# ---- 作图 ------------------------------------------------------------------
fig, (axA, axB) = plt.subplots(
    1, 2, figsize=(12.2, 5.0), gridspec_kw={"width_ratios": [1.35, 1.0]})
cgrid = np.linspace(0, 250, 800)

# ---- Panel A ----
for name, K, col in states:
    axA.plot(cgrid, eta_cP(cgrid, K), color=col, lw=2.6, label=name)

axA.axhline(50, color="k", ls="--", lw=1.1, alpha=0.55)
axA.text(1, 120, "practical injectability\nceiling ~50 cP",
         fontsize=9, color="k", va="top")

dv_s = divergence_c(K_STRONG)
axA.axvline(dv_s, color="#d62728", ls=":", lw=1.5, alpha=0.85)
axA.text(dv_s + 2, 4e4, "divergence pole\n≈ %.0f mg/mL" % dv_s,
         fontsize=9, color="#d62728", ha="left", va="top")

axA.set_xlabel("mAb concentration (mg/mL)", fontsize=11)
axA.set_ylabel("zero-shear viscosity (cP, log scale)", fontsize=11)
axA.set_yscale("log"); axA.set_ylim(0.9, 3e5); axA.set_xlim(0, 250)
axA.grid(alpha=0.25, which="both")
axA.legend(loc="upper right", fontsize=8.5, framealpha=0.95)
axA.set_title("A  Viscosity vs. concentration under three\n"
              "interaction regimes (B$_{22}$ sign)",
              fontsize=11)

# ---- Panel B : formulation funnel at fixed concentration ----
probe = 150.0
Kgrid = np.logspace(0, 4.2, 600)          # 1 .. ~1.6e4 M^-1
etaB  = np.array([eta_cP(probe, k) for k in Kgrid])
axB.plot(Kgrid, etaB, color="0.35", lw=2.0,
         label="eta at 150 mg/mL vs. K$_{eff}$")
axB.axhline(50, color="k", ls="--", lw=1.1, alpha=0.55)
axB.text(1.2, 130, "50 cP ceiling", fontsize=8.5, color="k", va="bottom")

for nm, K, col in states:
    yv = eta_cP(probe, max(K, 1e-6))
    xv = max(K, 1.0)
    axB.plot(xv, yv, "o", ms=9, color=col, mec="k", mew=0.6, zorder=6)
    if K <= 0:
        axB.annotate("micro-+ B$_{22}$\n(%.1f cP)" % yv, xy=(xv, yv),
                     xytext=(2.2, 15), fontsize=8.5,
                     arrowprops=dict(arrowstyle="->", lw=0.8, color="0.2"))
    else:
        axB.annotate("B$_{22}$ ~ 0\n(%.1f cP)" % yv, xy=(xv, yv),
                     xytext=(60, 8.0), fontsize=8.5,
                     arrowprops=dict(arrowstyle="->", lw=0.8, color="0.2")) if K < 1e3 else \
        axB.annotate("B$_{22}$ << 0\n(~%.0f cP)" % yv, xy=(xv, yv),
                     xytext=(1200, 3e2), fontsize=8.5,
                     arrowprops=dict(arrowstyle="->", lw=0.8, color="0.2"))

axB.text(0.015, 0.012,
         "direction of added 150 mM NaCl (hydrophobic-dominated mAb):\n"
         "salting-out + loss of charge-repulsion barrier  →  right",
         transform=axB.transAxes, fontsize=8.5, color="#d62728", va="bottom")
axB.set_xscale("log"); axB.set_yscale("log")
axB.set_xlim(1, 1.6e4); axB.set_ylim(0.9, 1e6)
axB.set_xlabel("effective transient self-association  K$_{eff}$ (M$^{-1}$)",
               fontsize=11)
axB.set_ylabel("viscosity at 150 mg/mL (cP, log scale)", fontsize=11)
axB.grid(alpha=0.25, which="both")
axB.set_title("B  Formulation funnel: how interaction sign\n"
              "sets the viscosity cliff", fontsize=11)

fig.suptitle("High-concentration antibody viscosity explosion: Mooney crowding + "
             "isodesmic transient self-association (simulation)",
             fontsize=12, y=0.995)
fig.tight_layout(rect=(0, 0, 1, 0.965))
fig.savefig("figure_viscosity_explosion_B22.png", dpi=200, facecolor="white")
print("\nsaved: figure_viscosity_explosion_B22.png")

# ---- 关键数值汇总 (供备忘录引用) -------------------------------------------
print("\nKEY NUMBERS (viscosity in cP):")
for cq in (100, 150, 175, 200, 250):
    print("  c=%4.0f mg/mL : rep=%7.1f | mid=%9.1f | strong=%9.1f"
          % (cq, eta_cP(cq, K_REP), eta_cP(cq, K_MID),
             min(eta_cP(cq, K_STRONG), 9e5)))
print("\n50 cP practical limit crossed at (mg/mL):",
      "rep=%.0f  mid=%.0f  strong=%.0f"
      % (c_at_eta(50, K_REP), c_at_eta(50, K_MID), c_at_eta(50, K_STRONG)))
