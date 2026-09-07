# -*- coding: utf-8 -*-
"""
lyophilization_devitrification_kinetics.py
===========================================

对抗性工程审查:高 Tg 冻干双抗"绝对安全冻结区"假说的非平衡热力学检验
----------------------------------------------------------------------

审查对象 (被审配方断言)
    海藻糖/甘露醇高比例 + 超快速退火冷冻 -> "Tg=65 °C 的均匀非晶基质"。
    由于室温 25 °C 比 Tg 低 ~40 °C,团队断言:平动/转动扩散"彻底停止",
    制剂内"绝不可能"发生亚微米相分离,5 年内蛋白去折叠与化学退化率"绝对为零"。

本脚本构建一个最小可检验的非平衡动力学模型,逐条检验上述断言:
  (1) α-松弛 (Adam-Gibbs 构象熵/协同重排区 CRR)   —— 全局协同重排的"表观冻结";
  (2) 次级 β (Johari-Goldstein) 松弛与界面结合水的局域快动力学 —— 在 Tg-40 K 依旧活跃;
  (3) 甘露醇在贮存中的去玻璃化/多形性结晶 (JMAK/δ→β) 排挤结合水,
      使海藻糖-蛋白界面上"有效可动水"点分数 p_eff(t) 上穿二维渗流阈值 p_c,
      形成跨表面的水化渗流团簇 (percolation cluster);
  (4) 渗流水网络耦合的固态化学动力学 (天冬酰胺脱酰胺 / 天冬氨酸异构化 /
      自由巯基-二硫键重排) —— 无宏观塌陷下的"隐蔽累积";
  (5) 界面水的局域均方位移 MSD(t):p<p_c 受限(平台),p>p_c 缓慢扩散(纳米-微米),
      证明局域迁移性在 5 年窗口内并不为零。

输出:
  * 控制台:关键时间常数、渗流临界时间、各温度情景 2 y/5 y 化学修饰率;
  * PNG 图件 (fig1...fig7):时间-温度松弛谱图、构象熵与 KWW 谱密度/可及窗口、
    2D/3D 渗流跨越概率曲线、团簇统计与 p_eff(t) 轨迹、MSD 曲线、化学退化累积曲线。

注意:所有动力学参数取"文献量级代表值"(见 PARAMS 与文首文献清单),
为情景化/现象学建模,并非对特定分子的预测性仿真;目的是在物理上推翻
"绝对为零"的断言并暴露控制变量,而非给出真实降解率。

用法:
    python lyophilization_devitrification_kinetics.py [--outdir DIR] [--fast]
"""

import argparse
import os
import textwrap

import numpy as np

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.ndimage import label as nd_label
from scipy.ndimage import generate_binary_structure

# ----------------------------------------------------------------------
# 物理常数
# ----------------------------------------------------------------------
R_GAS = 8.314462618          # J mol-1 K-1
YR = 365.25 * 24 * 3600.0    # 秒 / 年

# ----------------------------------------------------------------------
# 文献量级参数 (代表值;非实测,详见研报参考文献表)
#   - 无水海藻糖 Tg ~ 111-119 °C (常取 ~117 °C);水塑化使其显著下降
#   - 无定形甘露醇 Tg ~ 13 °C (Kim/Akers/Nail 1998);快冻倾向 δ 晶型
#   - β/JG 与结合水动力学量级引自介电/快动力学文献
# ----------------------------------------------------------------------
T0C = 273.15

PARAMS = dict(
    # --- 松弛学 -------------------------------------------------------
    Tg_matrix_C=65.0,        # 被审配方宣称的整饼 Tg (含水量~3%,水分塑化后)
    Tg_mann_C=13.0,          # 纯无定形甘露醇 Tg
    tau_g=100.0,             # Tg 约定:τ_α(Tg)=100 s
    tau0=1e-13,              # 振动前因子 (s)
    TK_matrix=280.0,         # 基质 Kauzmann 参考温度 (K),仅作 AG 外推骨架
    dCp_conf=6.0,            # 构象熵标定常数 (相对单位)
    # 次级松弛
    E_beta=55.0e3,           # JG β 松弛活化能 (J/mol)
    tau0_beta=1e-13,         # s
    # 界面结合水 (不可冻结水) 局域重取向/迁移
    E_water=48.0e3,          # J/mol
    tau0_water=1e-14,        # s
    # --- 渗流 ---------------------------------------------------------
    pc2=0.592746,            # 2D 正方格子 4-邻位渗流阈值 (site)
    pc3=0.311608,            # 3D 简立方 6-邻位渗流阈值 (site)
    nu=4.0 / 3.0,            # 关联长度临界指数 (2D)
    a0=0.40,                 # 水化位点格距 / 晶格常数 (nm)
    Lcap=25.0,               # 蛋白质表面域有限尺寸截断 (nm) —— 渗流发散被蛋白尺寸截断
    mu_cond=1.31,            # 电导/输运临界指数 (2D) ~1.3
    # --- 甘露醇去玻璃化/多形性结晶 (JMAK) -------------------------------
    n_avrami=1.6,            # 界面成核+生长
    E_dev=110.0e3,           # 结晶-晶型转化表观活化能 (J/mol)
    k_dev_ref=2.88e-8,       # 25°C 参考速率 (s-1),~1.1 年到 63% 结晶
    Tref_dev=298.15,
    # 排挤水的迁移滞后 (一阶)
    E_wmig=75.0e3,           # J/mol
    k_wmig_ref=5.0e-8,       # 25°C (s-1),滞后 ~0.6 年
    Tref_wmig=298.15,
    # 渗流驱动的水分再分布
    p0=0.40,                 # 贮存初始界面"可动水"点分数 (低于 p_c,隔离团簇)
    p1=0.78,                 # 结晶近乎完成时的界面点分数 (高于 p_c)
    # --- 化学 (固态,一级,水介导) -------------------------------------
    # 25 °C 参考一级速率 (s-1);乘以 1+(Rmax-1)*w_net/w_max 渗流增强
    kD_ref=2.2e-11,          # Asn 脱酰胺 (琥珀酰亚胺路径 -> Asp/isoAsp)
    kI_ref=1.2e-11,          # Asp 异构化 -> isoAsp
    kS_ref=1.1e-11,          # 巯基-二硫键重排/错误配对
    ED=105.0e3, EI=100.0e3, ES=115.0e3,   # 活化能 J/mol
    Rmax=10.0,               # 渗流"湿通道"对局域化学的最大增强倍数
    w_iso=0.06,              # 隔离(有限)水团簇的催化效率权重
    # --- 结合水 MSD ------------------------------------------------
    D_H2O_ref=0.02,          # 25 °C 贯穿(渗流)水网络等效扩散系数 nm^2/s
    E_H2O_msd=40.0e3,        # J/mol
    MSD_floor=0.02,          # 蛋白原子快速振动/笼内 MSD 底板 nm^2
)

# ----------------------------------------------------------------------
# 工具:单位换算 / 温标
# ----------------------------------------------------------------------
def C2K(Tc: float) -> float:
    return Tc + T0C


def log10tau_string(tau: float) -> str:
    if tau <= 0:
        return "-inf"
    return f"{np.log10(tau):.1f}"


# ----------------------------------------------------------------------
# 1) 构象熵 (Adam-Gibbs) 与 α-松弛
# ----------------------------------------------------------------------
def configurational_entropy(T: np.ndarray, TK: float, dCp: float) -> np.ndarray:
    """Adam-Gibbs 构象熵 S_c(T) = dCp * ln(T/T_K),T > T_K。"""
    return np.where(T > TK, dCp * np.log(np.maximum(T, 1e-9) / TK), 0.0)


def tau_alpha_AG(T: np.ndarray, Tg: float, tau_g: float, tau0: float,
                 TK: float, dCp: float) -> np.ndarray:
    """Adam-Gibbs:τ_α = τ0 exp(C/(T S_c(T))),用 τ_α(Tg)=τ_g 定标 C。"""
    Sc = configurational_entropy(np.asarray(T, float), TK, dCp)
    Scg = configurational_entropy(np.asarray([Tg], float), TK, dCp)[0]
    C_fit = np.log(tau_g / tau0) * Tg * Scg
    out = tau0 * np.exp(C_fit / (np.asarray(T, float) * Sc))
    out[Sc <= 0] = np.inf
    return out


def tau_vft_mann(T: np.ndarray, Tg: float, tau_g: float, tau0: float,
                 T0: float) -> np.ndarray:
    """局部甘露醇富集域 α 松弛 (VFT;Tg=13 °C 组分)。"""
    T = np.asarray(T, float)
    D = np.log(tau_g / tau0) * (Tg - T0) / T0
    return tau0 * np.exp(D * T0 / (T - T0))


def tau_beta(T: np.ndarray, Eb: float, tau0b: float) -> np.ndarray:
    """JG 次级松弛 (Arrhenius)。"""
    return tau0b * np.exp(Eb / (R_GAS * np.asarray(T, float)))


def tau_hydration_water(T: np.ndarray, Ew: float, tau0w: float) -> np.ndarray:
    """蛋白表面不可冻结结合水局域重取向/迁移 (Arrhenius)。"""
    return tau0w * np.exp(Ew / (R_GAS * np.asarray(T, float)))


# ----------------------------------------------------------------------
# 2) 渗流模拟 (2D/3D site percolation,Monte-Carlo)
# ----------------------------------------------------------------------
def _struct(dim: int):
    """获取指定连通性的结构元:2D 用 4-邻(→p_c=0.5927),3D 用 6-邻(→p_c=0.3116)。"""
    if dim == 2:
        return np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=int)
    return generate_binary_structure(3, 1).astype(int)


def run_percolation(sizes, ns_list, pgrid, dim, seed, compute_stats=True):
    """对每个晶格尺寸跑渗流:
    返回 {L: (pgrid, Pspan, Plarge, Sfin)}。
    Pspan:存在左-右(2D)/跨 x(3D)贯穿簇的概率
    Plarge:最大簇占据格点数 / L^dim
    Sfin: 平均(质量加权)有限簇尺寸测度 (排除最大簇)
    """
    struct = _struct(dim)
    rng = np.random.default_rng(seed)
    res = {}
    for L, ns in zip(sizes, ns_list):
        unif = rng.uniform(size=(ns,) + (L,) * dim)
        nL2 = L ** dim
        Pspan = np.zeros_like(pgrid, float)
        Plarge = np.zeros_like(pgrid, float)
        Sfin = np.zeros_like(pgrid, float)
        for j, p in enumerate(pgrid):
            active = unif < p
            sp = 0.0
            pl = 0.0
            sf = 0.0
            for i in range(ns):
                lab, _n = nd_label(active[i], structure=struct)
                if _n == 0:
                    continue
                cnt = np.bincount(lab.ravel())
                # cnt[0] 为背景;找最大簇
                big_idx = 1 + int(np.argmax(cnt[1:]))
                bsize = cnt[big_idx]
                pl += bsize / nL2
                if compute_stats:
                    sumsq = float((cnt * cnt).sum()) - float(bsize * bsize)
                    sf += sumsq / nL2
                # 贯穿检验
                if dim == 2:
                    left = set(lab[:, 0].tolist())
                    right = set(lab[:, -1].tolist())
                else:
                    left = set(lab[:, 0, :].ravel().tolist())
                    right = set(lab[:, -1, :].ravel().tolist())
                if not (left.isdisjoint(right)):
                    sp += 1.0
            Pspan[j] = sp / ns
            Plarge[j] = pl / ns
            if compute_stats:
                Sfin[j] = sf / ns
        res[L] = (pgrid, Pspan, Plarge, Sfin)
    return res


# ----------------------------------------------------------------------
# 3) 甘露醇去玻璃化 / 排挤水 / 界面点分数
# ----------------------------------------------------------------------
def xi_jmak(t, T, P):
    """JMAK(结晶-晶型转化结晶化分数 ξ ∈[0,1])。"""
    k = P["k_dev_ref"] * np.exp(-P["E_dev"] / R_GAS * (1.0 / T - 1.0 / P["Tref_dev"]))
    return 1.0 - np.exp(-(k * t) ** P["n_avrami"])


def water_redistribute(t, T, P):
    """排挤水的一阶滞后迁移率;d ξw/dt = k_w (ξ - ξw)。
    返回 ξ(t) 与 ξw(t) 的数组(独立于主积分,与 t 等长)。"""
    tt = np.asarray(t, float)
    xi = xi_jmak(tt, T, P)
    kw = P["k_wmig_ref"] * np.exp(-P["E_wmig"] / R_GAS * (1.0 / T - 1.0 / P["Tref_wmig"]))
    xiw = np.zeros_like(tt)
    for i in range(1, len(tt)):
        dt = tt[i] - tt[i - 1]
        # 解析式:对分段常数源;用 euler 足够(源变化慢)
        xiw[i] = xiw[i - 1] + kw * (xi[i - 1] - xiw[i - 1]) * dt
        xiw[i] = min(max(xiw[i], 0.0), 1.0)
    return xi, xiw


def p_effective(t, T, P, devitrify=True):
    """界面有效可动水点分数 p_eff(t)。devitrify=False -> 恒定(干态对照)。"""
    if not devitrify:
        return np.full_like(np.asarray(t, float), P["p0"])
    _xi, xiw = water_redistribute(t, T, P)
    return P["p0"] + (P["p1"] - P["p0"]) * xiw


# ----------------------------------------------------------------------
# 4) 团簇统计 -> 化学反应增强因子 w_net(p)
# ----------------------------------------------------------------------
def w_net_from_sim(plarge, p, pgrid, w_iso):
    """由渗流模拟结果构造"蛋白表面被渗流水润湿/催化的有效权重"。
    w_net(p) = P_large(p) + w_iso * max(p - P_large(p), 0)
    再按 pgrid 插值成闭式函数。"""
    pl_interp = np.interp(p, pgrid, plarge)
    return pl_interp + w_iso * np.maximum(np.asarray(p) - pl_interp, 0.0)


# ----------------------------------------------------------------------
# 5) 固态化学动力学 (一级,水介导增强)
# ----------------------------------------------------------------------
def degradation_kinetics(t, T, P, pfn, wfun, pgrid, plarge_sim):
    """计算各产物累积分数。pfn(t)->p_eff;wfun(p)->w_net。
    返回 dict(t, p_eff, R, xD, xI, xS, xT)"""
    tt = np.asarray(t, float)
    p_eff = np.clip(pfn(tt), 0.0, 1.0)
    w_arr = np.interp(p_eff, pgrid, wfun)
    wmax = np.interp(P["p1"], pgrid, wfun)
    g = 1.0 + (P["Rmax"] - 1.0) * w_arr / max(wmax, 1e-12)   # 增强因子

    def kbase(kref, Ea, T):
        return kref * np.exp(-Ea / R_GAS * (1.0 / T - 1.0 / 298.15))

    kD = kbase(P["kD_ref"], P["ED"], T) * g
    kI = kbase(P["kI_ref"], P["EI"], T) * g
    kS = kbase(P["kS_ref"], P["ES"], T) * g
    # 一级:A -> 产物;分段累积 ∫_0^t k(s) ds
    def cumint(kv):
        c = np.zeros_like(tt)
        c[1:] = np.cumsum(0.5 * (kv[1:] + kv[:-1]) * np.diff(tt))
        return c

    KD = cumint(kD)
    KI = cumint(kI)
    KS = cumint(kS)
    xD = 1.0 - np.exp(-KD)
    xI = 1.0 - np.exp(-KI)
    xS = 1.0 - np.exp(-KS)
    return dict(t=tt, p_eff=p_eff, R=g, xD=xD, xI=xI, xS=xS,
                xT=1.0 - np.exp(-(KD + KI + KS)))


# ----------------------------------------------------------------------
# 6) 界面结合水 MSD
# ----------------------------------------------------------------------
def water_msd(t, T, P, p_eff_path=None):
    """结合水局域均方位移 (nm^2)。

    固定 p 的情形:给定单个 p 返回时间函数;
    p_eff_path: 若给 (t_path, p_path),则沿存储轨迹积分。
    """
    pc = P["pc2"]
    nu = P["nu"]
    a0 = P["a0"]
    Lcap = P["Lcap"]
    mu = P["mu_cond"]
    DH = P["D_H2O_ref"] * np.exp(-P["E_H2O_msd"] / R_GAS * (1.0 / T - 1.0 / 298.15))

    def loc_length(p):
        # 关联/团簇尺度;p<pc 时 = a0 (pc/(pc-p))^nu,受蛋白表面尺寸截断
        if p >= pc - 1e-9:
            return Lcap
        return min(Lcap, a0 * (pc / (pc - p)) ** nu)

    if p_eff_path is None:
        p = P["p0"] if P.get("_p_fixed") is None else P["_p_fixed"]
        # 简化:使用闭式给定 p
        tt = np.asarray(t, float)
        if p < pc:
            ell = loc_length(p)
            # 有限团簇内局域迁移 -> 指数趋近平台
            tau_cl = max(ell * ell / (4.0 * DH), 1e-6)
            msd = P["MSD_floor"] + ell * ell * (1.0 - np.exp(-tt / tau_cl))
        else:
            Dp = DH * ((p - pc) / (1.0 - pc)) ** mu
            msd = P["MSD_floor"] + 4.0 * Dp * tt
        return msd

    # 沿存储轨迹积分(去玻璃化情景)
    tpath, ppath = p_eff_path
    tt = np.asarray(tpath, float)
    msd = np.zeros_like(tt, float)
    msd[0] = P["MSD_floor"]
    crossed = False
    tcross = None
    for i in range(1, len(tt)):
        pm = ppath[i - 1]
        if pm < pc:
            ell = loc_length(pm)
            msd[i] = P["MSD_floor"] + ell * ell
        else:
            if not crossed:
                crossed = True
                tcross = tt[i]
                ell0 = loc_length(pc - 1e-9)  # = Lcap
                msd[i] = P["MSD_floor"] + ell0 * ell0 + 0.0
            # 累积扩散项
            Dm = DH * ((max(pm - pc, 0.0)) / (1.0 - pc)) ** mu
            dt = tt[i] - tt[i - 1]
            msd[i] = msd[i - 1] + 4.0 * Dm * dt
    return msd


# ----------------------------------------------------------------------
# 图件
# ----------------------------------------------------------------------
def _style():
    plt.rcParams.update({
        "font.size": 9, "axes.titlesize": 10, "axes.labelsize": 9.5,
        "legend.fontsize": 7.5, "xtick.labelsize": 8, "ytick.labelsize": 8,
        "figure.dpi": 150, "savefig.dpi": 150, "axes.grid": True,
        "grid.alpha": 0.25, "axes.axisbelow": True,
    })


def fig1_relaxation_map(outdir):
    P = PARAMS
    Tg_mat = C2K(P["Tg_matrix_C"]); Tg_mann = C2K(P["Tg_mann_C"])
    T0_m = Tg_mann - 48.0
    T = np.linspace(235, 400, 500)
    Ta = np.linspace(P["TK_matrix"] + 4, 400, 400)   # AG 仅 T>T_K

    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        ta = np.clip(tau_alpha_AG(Ta, Tg_mat, P["tau_g"], P["tau0"],
                                  P["TK_matrix"], P["dCp_conf"]), 1e-13, 1e42)
        tam = np.clip(tau_vft_mann(T, Tg_mann, P["tau_g"], P["tau0"], T0_m),
                      1e-14, 1e42)
        tb = tau_beta(T, P["E_beta"], P["tau0_beta"])
        tw = tau_hydration_water(T, P["E_water"], P["tau0_water"])

    fig, ax = plt.subplots(figsize=(6.4, 4.4))
    ax.semilogy(1000.0 / Ta, ta, lw=2, color="#C0392B", label=r"$\alpha$-matrix (Adam-Gibbs, $T_g$=65°C)")
    ax.semilogy(1000.0 / T, tam, lw=1.6, color="#8E44AD", ls="--",
                label=r"$\alpha$-mannitol-rich microdomain ($T_g$≈13°C)")
    ax.semilogy(1000.0 / T, tb, lw=1.6, color="#2471A3",
                label=r"$\beta$ (Johari-Goldstein) relaxation")
    ax.semilogy(1000.0 / T, tw, lw=1.6, color="#1E8449", ls="-.",
                label=r"bound hydration water (unfreezable)")

    for lab, Tv, col in [("$T_g$=65°C", Tg_mat, "#555555"), ("$T_g$=13°C (mann)", Tg_mann, "#8E44AD")]:
        ax.axvline(1000.0 / Tv, color=col, lw=0.8, ls=":", alpha=0.7)
        ax.text(1000.0 / Tv + 0.02, 1e18, lab, rotation=90, fontsize=7.5, color=col,
                va="top", ha="right")

    ax.axvspan(1000.0 / (2.0 + T0C + 6.0), 1000.0 / (2.0 + T0C - 6.0),
               color="steelblue", alpha=0.10)
    ax.axvline(1000.0 / 298.15, color="#C0392B", lw=1.4)
    ax.text(1000.0 / 298.15 + 0.01, 3e4, "storage 25°C\n($T_g$−40 K)", fontsize=7.5,
            color="#C0392B", va="top")

    ax.axhline(P["tau_g"], color="k", lw=0.7, ls=":", alpha=0.6)
    ax.text(2.52, P["tau_g"] * 1.6, r"$\tau$=100 s (T$_\mathrm{g}$ convention)", fontsize=7, color="k")
    ax.axhline(YR, color="#C0392B", lw=0.9, ls="--", alpha=0.7)
    ax.text(2.52, YR * 1.8, "5 years", fontsize=7.5, color="#C0392B")

    ax.set_xlabel(r"1000 / $T$  (K$^{-1}$)")
    ax.set_ylabel(r"relaxation time  $\tau$  (s)")
    ax.set_ylim(1e-12, 1e42)
    ax.set_xlim(2.5, 4.25)
    # 顶轴标注温度
    ax2 = ax.twiny()
    ticks = [250, 275, 298, 325, 350, 400]
    ax2.set_xticks([1000.0 / t for t in ticks])
    ax2.set_xticklabels([f"{t}" for t in ticks])
    ax2.set_xlim(ax.get_xlim())
    ax2.set_xlabel(r"$T$ (K)  $\leftarrow$")
    ax.legend(loc="lower left", frameon=False)
    try:
        fig.tight_layout()
    except Exception:
        pass
    fig.savefig(os.path.join(outdir, "fig1_relaxation_map.png"))
    plt.close(fig)


def fig2_entropy_and_spectrum(outdir):
    P = PARAMS
    Tg_mat = C2K(P["Tg_matrix_C"]); Tg_mann = C2K(P["Tg_mann_C"])
    T0_m = Tg_mann - 48.0
    Tg_ref = 298.15

    fig, (axA, axB) = plt.subplots(1, 2, figsize=(9.6, 3.9), width_ratios=[0.9, 1.0])

    # ---- (a) 构象熵
    T = np.linspace(P["TK_matrix"], 400, 400)
    Sc = configurational_entropy(T, P["TK_matrix"], P["dCp_conf"])
    axA.plot(T - T0C, Sc, color="#C0392B", lw=2)
    axA.axvline(P["TK_matrix"] - T0C, color="k", ls=":", lw=0.8)
    axA.text(P["TK_matrix"] - T0C + 0.3, 0.02, r"$T_K$", fontsize=8)
    axA.axvspan(Tg_mat - T0C, 127.0, color="0.9")
    axA.text((Tg_mat + 350) / 2 - T0C, Sc.max() * 0.94,
             r"$T>T_g$: $\alpha$ dynamics accessible",
             ha="center", fontsize=6.5, color="#555555")
    # 标记 25°C 与 Tg-40
    axA.plot([25], [configurational_entropy(298.15, P["TK_matrix"], P["dCp_conf"])],
             "o", color="#C0392B")
    axA.annotate(r"$T_\mathrm{storage}$=25°C",
                 xy=(25, configurational_entropy(298.15, P["TK_matrix"], P["dCp_conf"])),
                 xytext=(40, Sc.max() * 0.55), fontsize=7.5,
                 arrowprops=dict(arrowstyle="->", lw=0.8, color="k"))
    axA.axhline(0, color="k", lw=0.5)
    axA.set_xlabel("T  (°C)")
    axA.set_ylabel(r"configurational entropy  $S_c$  (a.u.)")
    axA.set_xlim(0, 130)
    axA.set_title("(a) Adam–Gibbs configurational entropy", fontsize=9.5)

    # ---- (b) KWW-型多尺度谱密度 H(log10 τ) 在 25 °C
    ta_298 = tau_alpha_AG([Tg_ref], Tg_mat, P["tau_g"], P["tau0"], P["TK_matrix"], P["dCp_conf"])[0]
    tam_298 = tau_vft_mann([Tg_ref], Tg_mann, P["tau_g"], P["tau0"], T0_m)[0]
    tb_298 = tau_beta([Tg_ref], P["E_beta"], P["tau0_beta"])[0]
    tw_298 = tau_hydration_water([Tg_ref], P["E_water"], P["tau0_water"])[0]

    lta = np.log10(ta_298); ltam = np.log10(tam_298)
    ltb = np.log10(tb_298); ltw = np.log10(tw_298)

    comps = [
        (lta, 2.4, 0.55, "#C0392B", r"$\alpha$-matrix (cooperative, CRR)"),
        (ltam, 1.1, 0.10, "#8E44AD", r"$\alpha$-mannitol microdomain"),
        (ltb, 0.7, 0.12, "#2471A3", r"$\beta$ (JG)"),
        (ltw, 0.7, 0.18, "#1E8449", r"bound water (hydration)"),
        (-8.0, 0.9, 0.05, "#555555", r"protein fast/side-chain motions"),
    ]
    lt = np.linspace(-14, 46, 4000)
    H = np.zeros_like(lt)
    for mu_, sig, wgt, col, lab in comps:
        H += wgt / (np.sqrt(2 * np.pi) * sig) * np.exp(-0.5 * ((lt - mu_) / sig) ** 2)
        # 画峰值标记
        axB.axvline(mu_, color=col, lw=0.7, alpha=0.4)
    axB.plot(lt, H, color="k", lw=1.4)

    y5 = np.log10(YR)
    axB.axvline(y5, color="#C0392B", lw=1.2, ls="--")
    axB.fill_between(lt, H, where=lt < y5, color="#C0392B", alpha=0.10)
    axB.text(y5 + 0.2, H.max() * 0.5, r"$\log_{10}(\tau=5\,yr)$", rotation=90,
             fontsize=7, color="#C0392B", va="top")
    axB.text(-6, H.max() * 0.9,
             "region of motions able to\ncomplete within 5 years",
             fontsize=7, color="#C0392B", ha="center")
    axB.text(30, H.max() * 0.35, r"$\alpha$-matrix peak$\gg$5 yr",
             fontsize=7.5, color="#C0392B")

    for mu_, lab in [(ltb, r"$\beta$"), (ltw, r"H$_2$O"), (ltam, r"$\alpha_{mann}$"),
                     (lta, r"$\alpha_{mat}$")]:
        axB.annotate(lab, xy=(mu_, 0.0), xytext=(mu_ + 0.25, H.max() * 0.55),
                     fontsize=7, color="#333333",
                     arrowprops=dict(arrowstyle="->", lw=0.6, color="gray"))

    axB.set_xlabel(r"$\log_{10}(\tau / \mathrm{s})$")
    axB.set_ylabel(r"relaxation spectral density  $H$  (a.u.)")
    axB.set_xlim(-14, 46)
    axB.set_ylim(0, H.max() * 1.25)
    axB.set_title("(b) multi-decade relaxation spectrum at 25 °C", fontsize=9.5)

    try:
        fig.tight_layout()
    except Exception:
        pass
    fig.savefig(os.path.join(outdir, "fig2_entropy_and_spectrum.png"))
    plt.close(fig)


def fig3_percolation_crossing(outdir):
    P = PARAMS
    pgrid = np.linspace(0.30, 0.80, 81)
    res2 = run_percolation([32, 64, 128, 256], [240, 100, 40, 20],
                           pgrid, 2, seed=7, compute_stats=False)
    fig, (axL, axR) = plt.subplots(1, 2, figsize=(9.2, 4.0))
    cols = plt.cm.viridis(np.linspace(0.1, 0.85, 4))
    for k, L in enumerate([32, 64, 128, 256]):
        pg, Psp, _pl, _sf = res2[L]
        axL.plot(pg, Psp, lw=1.5, color=cols[k], label=f"L={L}")
    axL.axvline(P["pc2"], color="k", ls="--", lw=1.0)
    axL.text(P["pc2"] + 0.003, 0.03, r"$p_c$=0.5927", fontsize=8)
    axL.set_xlabel("water site occupancy  $p$")
    axL.set_ylabel(r"crossing probability  $\Pi(p;L)$")
    axL.set_title("(a) 2D interface (4-neighbour site percolation)", fontsize=9.5)
    axL.legend(frameon=False, loc="center left")
    axL.set_xlim(0.3, 0.8)

    pgrid3 = np.linspace(0.20, 0.45, 61)
    res3 = run_percolation([12, 18, 26], [200, 60, 30], pgrid3, 3, seed=9,
                           compute_stats=False)
    cols3 = plt.cm.plasma(np.linspace(0.2, 0.9, 3))
    for k, L in enumerate([12, 18, 26]):
        pg, Psp, _pl, _sf = res3[L]
        axR.plot(pg, Psp, lw=1.5, color=cols3[k], label=f"L={L}")
    axR.axvline(P["pc3"], color="k", ls="--", lw=1.0)
    axR.text(P["pc3"] + 0.003, 0.03, r"$p_c$=0.3116", fontsize=8)
    axR.set_xlabel("water site occupancy  $p$")
    axR.set_ylabel(r"crossing probability  $\Pi(p;L)$")
    axR.set_title("(b) 3D cake bulk (6-neighbour site percolation)", fontsize=9.5)
    axR.legend(frameon=False, loc="center left")
    axR.set_xlim(0.20, 0.45)
    try:
        fig.tight_layout()
    except Exception:
        pass
    fig.savefig(os.path.join(outdir, "fig3_percolation_crossing.png"))
    plt.close(fig)


def fig4_cluster_and_trajectory(outdir, t_yr, P):
    """团簇统计 + 25/40/5 °C 下的 p_eff(t) 轨迹与渗流穿越时刻。"""
    pgrid = np.linspace(0.30, 0.80, 81)
    res = run_percolation([128], [200], pgrid, 2, seed=11, compute_stats=True)
    _pg, _Psp, Plarge, Sfin = res[128]
    pc = P["pc2"]
    dS = np.where(Sfin > 0, Sfin, np.nan)

    fig, (axA, axB) = plt.subplots(1, 2, figsize=(9.4, 4.1))
    axA.plot(pgrid, Plarge, color="#1E8449", lw=2, label=r"$P_\infty$ (giant cluster fraction)")
    axA.plot(pgrid, dS / np.nanmax(dS), color="#C0392B", lw=1.8, ls="--",
             label=r"$\langle s\rangle$ finite-cluster size (norm.)")
    axA.axvline(pc, color="k", ls="--", lw=1)
    axA.text(pc + 0.003, 0.85, r"$p_c$", fontsize=8)
    # 标注 p0 / p1
    for pp, lab in [(P["p0"], r"$p_0$"), (P["p1"], r"$p_1$")]:
        axA.axvline(pp, color="#555555", ls=":", lw=1)
        axA.text(pp - 0.015, -0.1, lab, transform=axA.get_xaxis_transform(),
                 ha="center", fontsize=8, color="#555555")
    axA.set_xlabel("water site occupancy  $p$")
    axA.set_ylabel(r"cluster statistics  (a.u.)")
    axA.set_ylim(0, 1.05)
    axA.set_title("(a) percolation cluster statistics (2D, L=128)", fontsize=9.5)
    axA.legend(frameon=False, loc="upper left")

    axB.axhline(pc, color="k", ls="--", lw=1)
    axB.text(0.05, pc + 0.012, r"$p_c$ = 0.5927  (percolation threshold)", fontsize=7.5)
    axB.axhspan(0, P["p0"] + 0.01, color="#1E8449", alpha=0.06)
    tmax = max(t_yr)
    for Tk, col, ls in [(298.15, "#C0392B", "-"), (313.15, "#E67E22", "--"),
                        (278.15, "#2471A3", "-.")]:
        ts = t_yr * YR
        _xi, xiw = water_redistribute(ts, Tk, P)
        pe = P["p0"] + (P["p1"] - P["p0"]) * xiw
        axB.plot(t_yr, pe, color=col, ls=ls, lw=1.7,
                 label=f"T={Tk - T0C:.0f} °C")
        # crossing time
        idx = np.where(pe >= pc)[0]
        if len(idx):
            axB.plot([t_yr[idx[0]]], [pc], "o", color=col, ms=5, zorder=5)
    axB.set_xlabel("storage time  (yr)")
    axB.set_ylabel(r"interface water occupancy  $p_\mathrm{eff}(t)$")
    axB.set_title("(b) mannitol devitrification expels water: p(t) trajectory",
                  fontsize=9.5)
    axB.legend(frameon=False, loc="lower right")
    axB.set_xlim(0, tmax)
    try:
        fig.tight_layout()
    except Exception:
        pass
    fig.savefig(os.path.join(outdir, "fig4_cluster_and_trajectory.png"))
    plt.close(fig)
    return Plarge, pgrid


def fig5_msd(outdir, t, P, pgrid, Plarge, pl_traj, pl_traj_5, pl_traj_40):
    pc = P["pc2"]
    fig, (axA, axB) = plt.subplots(1, 2, figsize=(9.6, 4.2))

    # ---- (a) 固定 p 的 MSD 族
    tfull = np.logspace(-6, np.log10(5 * YR), 600)
    for pfix in [0.40, 0.55, 0.588, 0.62, 0.75]:
        P["_p_fixed"] = pfix
        try:
            msd = water_msd(tfull, 298.15, P)
        finally:
            P["_p_fixed"] = None
        tag = f"p={pfix}" + ("  (sub-$p_c$)" if pfix < pc else "  (super-$p_c$)")
        col = "#1E8449" if pfix < pc else "#C0392B"
        lw = 1.5 if abs(pfix - 0.62) > 1e-9 else 2.2
        axA.loglog(tfull, msd, color=col, lw=lw, alpha=0.9, label=tag)
    for lev, lab in [(1.0, r"(1 nm)$^2$"), (1e2, r"(10 nm)$^2$"),
                     (1e4, r"(100 nm)$^2$"), (1e6, r"(1 $\mu$m)$^2$")]:
        axA.axhline(lev, color="gray", lw=0.5, ls=":", alpha=0.6)
        axA.text(tfull[0] * 1.2, lev * 1.3, lab, fontsize=6, color="gray")
    axA.axvline(YR * 5, color="#C0392B", ls="--", lw=1)
    axA.text(YR * 5 * 0.8, 3e5, "5 yr", fontsize=7, color="#C0392B")
    axA.set_xlabel(r"time  $t$  (s)")
    axA.set_ylabel(r"MSD  $\langle \Delta r^2(t)\rangle$  (nm$^2$)")
    axA.set_title("(a) bound-water MSD: sub- vs super-$p_c$ (25 °C)", fontsize=9.5)
    axA.legend(frameon=False, fontsize=6.5, loc="upper left")

    # ---- (b) 25/5/40 °C 贮存轨迹下的 MSD (t>0 起画)
    tm = t[1:]
    axB.loglog(tm, pl_traj[1:], color="#C0392B", lw=2,
               label="25 °C (devitrification → percolation)")
    axB.loglog(tm, pl_traj_5[1:], color="#2471A3", lw=1.6, ls="--",
               label="2–8 °C (crystallization arrested)")
    axB.loglog(tm, pl_traj_40[1:], color="#E67E22", lw=1.6, ls="-.",
               label="40 °C (fast devitrification)")
    for lev, lab in [(1.0, "1 nm"), (1e2, "10 nm"), (1e4, "100 nm"), (1e6, r"1 $\mu$m")]:
        axB.axhline(lev, color="gray", lw=0.5, ls=":", alpha=0.6)
        axB.text(tm[5] * 1.1, lev * 1.25, lab, fontsize=6, color="gray")
    axB.axvline(YR, color="k", ls=":", lw=0.8, alpha=0.5)
    axB.text(YR * 1.05, 2e6, "1 yr", fontsize=6.5)
    axB.axvline(YR * 5, color="#C0392B", ls="--", lw=1)
    axB.text(YR * 5 * 0.8, 5e5, "5 yr", fontsize=7, color="#C0392B")
    # 蛋白尺度参考
    axB.axhspan(0.1, (14) ** 2, color="steelblue", alpha=0.06)
    axB.text(tm[-1] * 0.6, 6e1, "mAb diameter ≈ 14 nm", fontsize=6.5, color="steelblue")
    axB.set_xlabel(r"storage time  $t$  (s)")
    axB.set_ylabel(r"MSD  $\langle \Delta r^2(t)\rangle$  (nm$^2$)")
    axB.set_title("(b) MSD trajectory during 5-y storage", fontsize=9.5)
    axB.legend(frameon=False, fontsize=6.8, loc="lower right")
    try:
        fig.tight_layout()
    except Exception:
        pass
    fig.savefig(os.path.join(outdir, "fig5_msd.png"))
    plt.close(fig)


def fig6_chemistry(outdir, res25, res_dry, res5, res40):
    fig, (axA, axB) = plt.subplots(1, 2, figsize=(9.6, 4.1))
    t_yr = res25["t"] / YR

    axA.plot(t_yr, res25["xD"] * 100, color="#C0392B", lw=1.7, label="deamidation (Asn)")
    axA.plot(t_yr, res25["xI"] * 100, color="#E67E22", lw=1.5, label="isomerization (Asp)")
    axA.plot(t_yr, res25["xS"] * 100, color="#8E44AD", lw=1.5, label="disulfide scrambling")
    axA.plot(t_yr, res25["xT"] * 100, color="k", lw=2.2, label="total modified fraction")
    axA.set_xlabel("storage time  (yr)")
    axA.set_ylabel("modified fraction  (%)")
    axA.set_title("(a) covert accumulation at 25 °C (percolation scenario)", fontsize=9.5)
    axA.legend(frameon=False, loc="center left")
    axA.set_xlim(0, 5)

    for r, col, lab in [(res5, "#2471A3", "2–8 °C"), (res_dry, "#1E8449",
                       "25 °C dry / no mannitol devitrification"),
                       (res25, "#C0392B", "25 °C (percolation scenario)"),
                       (res40, "#E67E22", "40 °C")]:
        axB.plot(t_yr, r["xT"] * 100, color=col, lw=1.8, label=lab)
    axB.set_xlabel("storage time  (yr)")
    axB.set_ylabel("total modified fraction  (%)")
    axB.set_title("(b) scenario comparison", fontsize=9.5)
    axB.legend(frameon=False, loc="upper left")
    axB.set_xlim(0, 5)
    try:
        fig.tight_layout()
    except Exception:
        pass
    fig.savefig(os.path.join(outdir, "fig6_chemistry.png"))
    plt.close(fig)


# ----------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--outdir", default=".")
    ap.add_argument("--fast", action="store_true",
                    help="减少渗流抽样(演示用,更快)")
    args = ap.parse_args()
    outdir = args.outdir
    os.makedirs(outdir, exist_ok=True)
    _style()

    P = PARAMS
    Tg_mat = C2K(P["Tg_matrix_C"]); Tg_mann = C2K(P["Tg_mann_C"])
    T0_m = Tg_mann - 48.0
    T25 = 298.15
    y5 = 5.0 * YR

    # ---------- 关键时间常数 (25 °C) ----------
    ta_m = tau_alpha_AG([T25], Tg_mat, P["tau_g"], P["tau0"], P["TK_matrix"],
                        P["dCp_conf"])[0]
    tam_m = tau_vft_mann([T25], Tg_mann, P["tau_g"], P["tau0"], T0_m)[0]
    tb_m = tau_beta([T25], P["E_beta"], P["tau0_beta"])[0]
    tw_m = tau_hydration_water([T25], P["E_water"], P["tau0_water"])[0]

    # ---------- 时间网格 ----------
    t_yr = np.linspace(0.0, 5.0, 2001)
    t = t_yr * YR

    # ---------- 渗流模拟 ----------
    # 集群统计 L=128 (供化学增强因子 & MSD)
    pgrid = np.linspace(0.30, 0.80, 81)
    res_stats = run_percolation([128], [200], pgrid, 2, seed=11, compute_stats=True)
    Plarge128 = res_stats[128][2]
    # 化学增强权重 (插值函数,pgrid-> 平滑闭式)
    wfun = w_net_from_sim(Plarge128, pgrid, pgrid, P["w_iso"])

    # ---------- 情景积分 ----------
    def deg_scenario(Tk, devitrify=True):
        pfn = lambda tt: p_effective(tt, Tk, P, devitrify=devitrify)
        return degradation_kinetics(t, Tk, P, pfn, wfun, pgrid, Plarge128)

    res25 = deg_scenario(298.15, True)
    res40 = deg_scenario(313.15, True)
    res5 = deg_scenario(278.15, True)
    res_dry = deg_scenario(298.15, False)     # 干态/无结晶对照 (25 °C)

    # ---------- 渗流临界时间 (25 °C) ----------
    pe25 = res25["p_eff"]
    cross25 = t_yr[np.where(pe25 >= P["pc2"])[0][0]] if np.any(pe25 >= P["pc2"]) else None

    # ---------- MSD 轨迹 ----------
    msd25 = water_msd(t, 298.15, P, p_eff_path=(t, res25["p_eff"]))
    msd5 = water_msd(t, 278.15, P, p_eff_path=(t, res5["p_eff"]))
    msd40 = water_msd(t, 313.15, P, p_eff_path=(t, res40["p_eff"]))

    # ---------- 图件 ----------
    print("[1/6] fig1: relaxation map ...")
    fig1_relaxation_map(outdir)
    print("[2/6] fig2: entropy + spectrum ...")
    fig2_entropy_and_spectrum(outdir)
    print("[3/6] fig3: percolation crossing (2D/3D) ...")
    fig3_percolation_crossing(outdir)
    print("[4/6] fig4: cluster statistics + p(t) trajectory ...")
    Plarge4, pgrid4 = fig4_cluster_and_trajectory(outdir, t_yr, P)
    print("[5/6] fig5: MSD ...")
    fig5_msd(outdir, t, P, pgrid, Plarge128, msd25, msd5, msd40)
    print("[6/6] fig6: chemistry ...")
    fig6_chemistry(outdir, res25, res_dry, res5, res40)

    # ---------- 控制台报告 ----------
    def pct(x):
        return f"{x * 100:.2f} %"

    lines = []
    lines.append("=" * 78)
    lines.append(" 冻结区假说检验 —— 关键时间常数 @ 25 °C (Tg,matrix=65 °C, Tg−40 K)")
    lines.append("=" * 78)
    lines.append(f"  α-relaxation  (matrix, Adam-Gibbs)      τ = 10^{np.log10(ta_m):.1f} s      (>10^{np.log10(YR*5):.1f} s = 5 yr)")
    lines.append(f"  α-relaxation  (mannitol-rich domain)     τ = {tam_m:.3g} s        ← 甘露醇域在室温已可动")
    lines.append(f"  β (JG) secondary relaxation              τ = {tb_m:.3g} s")
    lines.append(f"  bound hydration water (unfreezable)       τ = {tw_m:.3g} s")
    lines.append(f"  5-year window                             τ* = {y5:.3g} s")
    lines.append("")
    lines.append("  结论:表观冻结仅适用于'协同 α'自由度;β / 结合水在 5 年窗内完全活跃。")
    lines.append("")
    lines.append("-" * 78)
    lines.append(" 渗流相变")
    lines.append("-" * 78)
    lines.append(f"  2D 界面渗流阈值 p_c       = {P['pc2']:.4f}")
    lines.append(f"  3D 体相渗流阈值 p_c       = {P['pc3']:.4f}")
    lines.append(f"  25 °C 贮存 p_eff 穿越阈值时间 t_c = {cross25:.2f} yr (若 <5 yr → 渗流网络在贮存期内形成)")
    lines.append("")
    lines.append("-" * 78)
    lines.append(" 界面结合水迁移性 (MSD)")
    lines.append("-" * 78)
    rms25 = np.sqrt(msd25[-1]); rms40 = np.sqrt(msd40[-1])
    rms5 = np.sqrt(msd5[-1])
    # 干态对照:水被限制在蛋白表面孤立团簇内,由关联长度给出受限 RMS
    ell_dry = P["a0"] * (P["pc2"] / (P["pc2"] - P["p0"])) ** P["nu"]
    rms_dry = np.sqrt(P["MSD_floor"] + ell_dry ** 2)
    lines.append(f"  RMS(5 yr) @ 25 °C (percolation)      = {rms25:.0f} nm   "
                 f"(≈ {rms25 / 14:.1f}× mAb 直径)")
    lines.append(f"  RMS(5 yr) @ 40 °C (percolation)      = {rms40:.0f} nm")
    lines.append(f"  RMS(5 yr) @ 2–8 °C (arrested)        = {rms5:.2f} nm")
    lines.append(f"  RMS(5 yr) @ 25 °C dry / p=p0 (受限)   = {rms_dry:.2f} nm "
                 f"(被蛋白表面域截断)")
    lines.append("")
    lines.append("-" * 78)
    lines.append(" 化学退化:5 年累积修饰分数 ('绝对为零'断言检验)")
    lines.append("-" * 78)
    rows = [("25 °C percolation scenario", res25), ("40 °C percolation", res40),
            ("2–8 °C", res5), ("25 °C dry control", res_dry)]
    lines.append(f"  {'scenario':<34}{'deamid.':>9}{'isom.':>9}{'shuffle':>9}{'total':>9}")
    for lab, r in rows:
        lines.append(f"  {lab:<34}{pct(r['xD'][-1]):>9}{pct(r['xI'][-1]):>9}"
                     f"{pct(r['xS'][-1]):>9}{pct(r['xT'][-1]):>9}")
    lines.append("")
    y2 = np.argmin(np.abs(t_yr - 2.0))
    lines.append(f"  25 °C 情景 2 年 total = {pct(res25['xT'][y2])}  (首年渗流前增量小 → '表观安全'窗口)")
    lines.append("  对照假说断言:total(5 yr, 25 °C) ≡ 0 —— 模型输出与其矛盾 ⇒ 断言不可成立。")
    lines.append("=" * 78)

    report = "\n".join(lines)
    print(report)
    with open(os.path.join(outdir, "sim_summary.txt"), "w", encoding="utf-8") as f:
        f.write(report)
    print(f"\nFigures & summary written to: {os.path.abspath(outdir)}")


if __name__ == "__main__":
    main()
