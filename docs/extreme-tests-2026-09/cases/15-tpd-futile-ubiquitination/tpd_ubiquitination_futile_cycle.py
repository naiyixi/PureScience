#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tpd_ubiquitination_futile_cycle.py
===================================

《靶向蛋白降解(TPD)中的无益循环与泛素链拓扑失效机制》多尺度非平衡 ODE 模型
（对抗性因果推演 / 极端场景审查用 in-silico 演示）

一个"超紧密、超高协同性"分子胶(Molecular Glue) 的细胞动力学反驳模型：

  药物团队主张 : TF-X · CRBN 三元复合物 Kd < 1 nM, α > 100,
                体外 5 min 快速高泛素化  =>  细胞内 pM 深度降解, 无动力学死循环。

  本模型(与研报)证明 : 亲和力(k_off)与催化定向/产物释放必须处于一个
  "动力学金发姑娘窗口"。当 k_off 被推向极小(超紧密/锁死几何)时:
     (i)  几何受阻 => 单一位点短链/非规范链, 而非蛋白酶体所需的 K48-四泛素;
     (ii) CRL 周期性活化(NAE 加 NEDD8 / CSN 去 NEDD8)、E2~Ub 反复装载、
          与 DUB(USP7/USP14 类)反向剪切的净效果是一个"无益耗能循环":
          泛素化通量很高(体外 blot "泛素化很强"), 但蛋白酶体净降解 ≈ 0
          (Dmax < 20%: "体外极强, 胞内无降解" 的反常脱节)。

---------------------------------------------------------------------------
模型物种 (单位: nM; 时间: s)
---------------------------------------------------------------------------
  E3 池 :
    D           去 NEDD8 的(非活性)CRL4^CRBN
    N           NEDD8 化(活性)CRL4^CRBN, 游离
  TF-X 底物池 (长度 = 底物上可被蛋白酶体识别的"有效(类K48)泛素链"单位数,
               4 表示 >=4, 即已越过蛋白酶体识别阈值) :
    S           游离未修饰 TF-X (长度 0, 游离)
    B_0..B_4    三元复合物(活性 E3 · 底物), 底物链长 0..4
    F_1..F_4    游离底物, 链长 1..4
    累积量 :
    X           已降解(被 26S 转运去折叠)的底物
    cUb         累积"偶联尝试"事件数(每次尝试 = 1 次 E2~Ub 装载/活化, ~2 ATP)
    cNed        累积 NEDD8 化(NAE)事件数
    cTet        累积"链延伸越过 >=4"事件数 (e3 通量)

---------------------------------------------------------------------------
过程(速率, 均已注释单位)
---------------------------------------------------------------------------
  [CRL 周期性活化循环 - Neddylation / Deneddylation]
    D  --NAE(kNAE)------------------------------> N            (活化, 耗 ATP)
    N  --CSN 基础去 NEDD8(kdenN)----------------> D
    B_i--CSN 去 NEDD8 耦合释放(kCSN)------------> D + F_i      (去活化并放行底物)
  [三元复合物组装]
    N + S  --kA(胶饱和、表观二级)-------------> B_0
    N + F_i--kA*w_rebind----------------------> B_i   (已泛素化底物再结合被压制)
    B_i    --k_off(解离)----------------------> N + F_i  (游离底物, E3 仍活性)
  [逐级泛素化链延伸 (Mono->Di->Tri->Tetra, 每次尝试 ~2 ATP)]
    B_0 --kU*q0-----> B_1
    B_i --kU*qx(tau)-> B_{i+1}     (i=1..3)  qx 为"K48 型链延伸几何效率"
    其中 q0 / qx 依赖有效停留时间 tau = 1/(k_off + kCSN):
       tau 极小(弱结合)  => 每次结合内可完成的尝试次数太少(动力学失败端)
       tau 极大(超紧密)  => 复合物退火为刚性"锁死"构象; 延伸 K48 链的受体
                           赖氨酸/近端 Ub-K48 无法靠拢 E2~Ub 硫酯核心,
                           qx -> 0 (几何/拓扑失败端: 仅剩同一单一位点
                           反复单泛素化或非规范短链 K6/K11 ...)
       tau 适中           => "金发姑娘窗口": 有足够停留完成链延伸, 又未锁死
  [DUB 反向剪切 (USP7 / USP14 类, 无 ATP 消耗)]
    F_i --kDUB*dub_fold-----> F_{i-1}    (游离链从远端逐 Ub 剪短; F_1 -> S)
    B_i --theta*kDUB*dub_fold-> B_{i-1}  (结合态剪切, 链被复合物部分屏蔽)
  [26S 蛋白酶体结合与去折叠转运]
    F_4 --kProt-----------------------> X (降解; 转运/去折叠消耗 ATP)
---------------------------------------------------------------------------
能耗核算 (每次偶联尝试 ~2 ATP; 每次 NEDD8 化 ~2 ATP; 每次蛋白酶体降解 ~150 ATP)
---------------------------------------------------------------------------
"""
from __future__ import annotations

import numpy as np
from scipy.integrate import solve_ivp
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
# 中文字体(图中含中文标签); 缺失时回退 DejaVu
plt.rcParams["font.sans-serif"] = ["PingFang SC", "Hiragino Sans GB", "Heiti SC",
                                   "Songti SC", "Arial Unicode MS", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

# --------------------------------------------------------------------------
# 物种/累积量索引
# --------------------------------------------------------------------------
ID, IN, IS = 0, 1, 2
IB0, IB1, IB2, IB3, IB4 = 3, 4, 5, 6, 7
IF1, IF2, IF3, IF4 = 8, 9, 10, 11
IX, ICU, ICN, ICT = 12, 13, 14, 15
NST = 16

NAMES = ["D", "N", "S", "B0", "B1", "B2", "B3", "B4",
         "F1", "F2", "F3", "F4", "X", "cUb", "cNed", "cTet"]

ATP_UB  = 2.0     # 一次泛素偶联(尝试): E1/E2 活化 ~2 个高能磷酸键
ATP_NED = 2.0     # 一次 NEDD8 化(NAE)
ATP_PRO = 150.0   # 一次 26S 转运+去折叠(近似)

T_END = 86400.0   # 24 h


# --------------------------------------------------------------------------
# 参数
# --------------------------------------------------------------------------
def default_params(**over):
    """默认生理参数(细胞, 胶饱和给药)。override 见各键。"""
    p = dict(
        E3tot   = 100.0,    # 总 CRBN-CRL4 池 (nM)
        S0      = 100.0,    # 总 TF-X (nM)
        kA      = 5.0e-3,   # 三元组装表观二级速率 (nM^-1 s^-1), 胶饱和
        w_rebind= 0.02,     # 已泛素化 F_i 再结合进入三元复合物的相对折扣
        koff    = 4.0e-3,   # 三元复合物解离速率 (s^-1)  ← 扫掠轴1 (寿命=1/k_off)
        kCSN    = 5.0e-4,   # CSN 去NEDD8耦合释放 (s^-1)   (超长停留的"上限")
        kdenN   = 2.0e-4,   # 游离活性 CRL 基础去NEDD8 (s^-1)
        kNAE    = 5.0e-2,   # NAE 催化的 NEDD8 化 (s^-1)
        kU      = 0.06,     # E2~Ub 装载/偶联"尝试"通量 (s^-1 / 结合复合物)
        tauC    = 150.0,    # 几何锁死阈值停留时间 (s)
        s_pow   = 2.2,      # 锁死 Hill 陡度
        tauL    = 300.0,    # 首 Ub 可及性衰减尺度 (s)
        kDUB_ref= 0.03,     # 参考去泛素化速率 (s^-1 / 链长单位), 生理=1x
        dub_fold= 1.0,      # DUB 活性倍数(相对生理)  ← 扫掠轴2
        theta   = 0.12,     # 结合态(B)中链被 DUB 剪切的比例(屏蔽因子)
        kProt   = 0.05,     # 游离 F4 被 26S 结合并降解 (s^-1)
        t_end   = T_END,
    )
    p.update(over)
    return p


def geometry(p):
    """由停留时间 tau=1/(k_off+kCSN) 计算首Ub效率 q0 与 K48链延伸效率 qx。"""
    tau = 1.0 / (p["koff"] + p["kCSN"])
    L = tau / (tau + p["tauL"])                     # 锁死度 0..1
    q0 = max(0.0, 0.95 - 0.40 * L)                  # 第一 Ub: 仅随锁死轻度下降
    qx = 1.0 / (1.0 + (tau / p["tauC"]) ** p["s_pow"])  # 延伸: 强锁死下 ->0
    return tau, q0, qx


# --------------------------------------------------------------------------
# 状态初值
# --------------------------------------------------------------------------
def y0(p):
    y = np.zeros(NST)
    y[IN] = p["E3tot"]      # 假设 NAE 充足, 起始即 NEDD8 化活性池
    y[IS] = p["S0"]
    return y


# --------------------------------------------------------------------------
# ODE 右端函数 (16 维)
# --------------------------------------------------------------------------
def rhs(t, y, p):
    y = np.clip(y, 0.0, None)
    D, N, S = y[ID], y[IN], y[IS]
    b0, b1, b2, b3, b4 = y[IB0], y[IB1], y[IB2], y[IB3], y[IB4]
    f1, f2, f3, f4 = y[IF1], y[IF2], y[IF3], y[IF4]

    _, q0, qx = geometry(p)
    koff = p["koff"]; kCSN = p["kCSN"]; rel = koff + kCSN
    kA = p["kA"]; w = p["w_rebind"]; kU = p["kU"]
    kdt = p["kDUB_ref"] * p["dub_fold"]          # 游离态 DUB 剪切
    kdb = p["theta"] * kdt                        # 结合态 DUB 剪切
    kProt = p["kProt"]

    # 三元组装
    asmS = kA * N * S
    asmF1 = kA * N * f1 * w
    asmF2 = kA * N * f2 * w
    asmF3 = kA * N * f3 * w
    asmF4 = kA * N * f4 * w
    # 链延伸 (productive)
    e0 = kU * b0 * q0
    e1 = kU * b1 * qx
    e2 = kU * b2 * qx
    e3 = kU * b3 * qx

    d = np.zeros(NST)
    # CRL 周期性活化循环
    d[ID] = kCSN * (b0 + b1 + b2 + b3 + b4) + p["kdenN"] * N - p["kNAE"] * D
    d[IN] = (p["kNAE"] * D - p["kdenN"] * N
             - (asmS + asmF1 + asmF2 + asmF3 + asmF4)
             + koff * (b0 + b1 + b2 + b3 + b4))
    # 底物/链物种
    d[IS] = -asmS + rel * b0 + kdt * f1
    d[IB0] = asmS + kdb * b1 - rel * b0 - e0
    d[IB1] = asmF1 - rel * b1 + e0 - e1 + kdb * (b2 - b1)
    d[IB2] = asmF2 - rel * b2 + e1 - e2 + kdb * (b3 - b2)
    d[IB3] = asmF3 - rel * b3 + e2 - e3 + kdb * (b4 - b3)
    d[IB4] = asmF4 - rel * b4 + e3 - kdb * b4
    d[IF1] = rel * b1 - kdt * f1 + kdt * f2 - asmF1
    d[IF2] = rel * b2 - kdt * f2 + kdt * f3 - asmF2
    d[IF3] = rel * b3 - kdt * f3 + kdt * f4 - asmF3
    d[IF4] = rel * b4 - kdt * f4 - kProt * f4 - asmF4
    # 26S 转运降解
    d[IX] = kProt * f4
    # 累积量 (能耗/无益循环审计)
    d[ICU] = kU * (b0 + b1 + b2 + b3 + b4)      # 每次偶联"尝试" ~2 ATP
    d[ICN] = p["kNAE"] * D                       # 每次 NEDD8 化 ~2 ATP
    d[ICT] = e3                                  # 越过 >=4 链的次数
    return d


def solve(p, t_eval=None, method="LSODA", rtol=1e-4, atol=1e-3):
    """积分至 p['t_end']; t_eval 为所需时刻数组(秒)。"""
    t_end = p["t_end"]
    te = t_eval if t_eval is not None else [t_end]
    sol = solve_ivp(rhs, (0.0, t_end), y0(p), t_eval=np.asarray(te, float),
                    args=(p,), method=method, rtol=rtol, atol=atol,
                    max_step=3600.0)
    if not sol.success:
        raise RuntimeError(f"solver failed: {sol.message}")
    return sol.t, sol.y


# --------------------------------------------------------------------------
# 结果度量
# --------------------------------------------------------------------------
def metrics(y_end, p):
    S0 = p["S0"]
    X = y_end[IX]
    cUb = y_end[ICU]
    cTet = y_end[ICT]
    stand = _standing_lengths(y_end)
    deg = X / S0 * 100.0
    # 无益(耗能)循环指数: 平均每个底物副本的偶联尝试数 / (达到降解所需的最少4次)
    events = cUb / S0
    needed = 4.0 * (X / S0)
    futile = (events / needed) if needed > 1e-12 else np.inf
    atp_conj = ATP_UB * events                      # 每底物 偶联ATP
    atp_prot = ATP_PRO * (X / S0)                   # 每底物 降解ATP
    atp_ned  = ATP_NED * (y_end[ICN] / p["E3tot"])  # 每E3 NEDD8化ATP
    return dict(
        Dmax_pct=deg, events_per_sub=events, tetra_per_sub=cTet / S0,
        mean_len=stand[0], short_frac=stand[1], futile=futile,
        atp_conj=atp_conj, atp_prot=atp_prot, atp_ned=atp_ned)


def _standing_lengths(y):
    """返回 (加权平均链长, 短链(<4)占已泛素化物种比例, 各长度占比)"""
    u1 = y[IB1] + y[IF1]; u2 = y[IB2] + y[IF2]
    u3 = y[IB3] + y[IF3]; u4 = y[IB4] + y[IF4]
    tot = u1 + u2 + u3 + u4
    if tot <= 0:
        return (0.0, 1.0, (0.0, 0.0, 0.0, 0.0))
    meanlen = (u1 + 2 * u2 + 3 * u3 + 4 * u4) / tot
    short = (u1 + u2 + u3) / tot
    return (meanlen, short, (u1 / tot, u2 / tot, u3 / tot, u4 / tot))


def named_solutions(times=None):
    """返回经典场景解(用于图2/图3)."""
    if times is None:
        times = _time_grid()
    scens = {
        "goldilocks  koff=4e-3 (Kd~0.8nM)":      dict(koff=4.0e-3, dub_fold=1.0),
        "window-edge koff=1e-3 (sub-nM)":        dict(koff=1.0e-3, dub_fold=1.0),
        "ultra-tight koff=1e-5 (Kd~2pM)":        dict(koff=1.0e-5, dub_fold=1.0),
        "ultra-tight + 3x DUB":                  dict(koff=1.0e-5, dub_fold=3.0),
    }
    out = {}
    for name, ov in scens.items():
        p = default_params(**ov)
        t, y = solve(p, t_eval=times)
        out[name] = (t, y, p)
    return out


def _time_grid():
    """覆盖 ~3 s .. 24 h 的采样时刻(用于时间历程图/快照)."""
    snap = [60.0, 300.0, 900.0, 1800.0, 3600.0, 7200.0, 14400.0, 43200.0, T_END]
    return np.unique(np.concatenate([
        np.logspace(np.log10(3.0), np.log10(T_END), 200), snap]))


# --------------------------------------------------------------------------
# 场景汇总表 (终端打印)
# --------------------------------------------------------------------------
def scenario_table():
    print("=" * 108)
    print("  场景                          停留τ/s   Dmax(24h)%  偶联/底物   "
          "≥4链/底物  平均链长  短链比%   无益指数(×min)")
    print("=" * 108)
    for name, ov in named_solutions().items():
        t, y, p = ov
        tau, _, _ = geometry(p)
        m = metrics(y[:, -1], p)
        fut = np.inf if m["futile"] == np.inf else m["futile"]
        fut_s = "inf" if fut == np.inf else f"{fut:9.1f}"
        print(f"  {name:<30}{tau:9.1f}{m['Dmax_pct']:12.1f}"
              f"{m['events_per_sub']:11.1f}{m['tetra_per_sub']:11.2f}"
              f"{m['mean_len']:11.2f}{m['short_frac']*100:10.1f}"
              f"{fut_s:>14}")
    print("=" * 108)


def in_vitro_cell_contrast(koff=1.0e-5):
    """'体外泛素化极强 / 胞内不降解'反常脱节的边界对照(同一动力学核)。

    体外近似: 关掉 DUB(kDUB=0)、26S(kProt=0)、CSN/去NEDD8(kCSN=0) —
              即纯化泛素化体系的读值条件(可见大量泛素化修饰累积)。
    体内近似: 生理 DUB(1x)、26S 与 CSN 齐全(同样分子, 同样 k_off)。
    """
    S0 = default_params()["S0"]
    pv = default_params(koff=koff, dub_fold=0.0, kProt=0.0, kCSN=0.0)
    tv = np.linspace(0.0, 300.0, 121)                    # 0-5 min
    _, yv = solve(pv, t_eval=tv)
    yv5 = yv[:, -1]
    conj_vitro = (sum(yv5[i] for i in range(IB1, IB4 + 1)) +
                  sum(yv5[i] for i in range(IF1, IF4 + 1))) / S0 * 100.0
    mean_len_vitro = _standing_lengths(yv5)[0]

    pc = default_params(koff=koff, dub_fold=1.0)
    _, yc = solve(pc)
    met = metrics(yc[:, -1], pc)

    print("\n[体外 vs 体内 反常脱节对照]  同一超紧密分子 (k_off=%.0e s^-1, Kd~2 pM)"
          % koff)
    print(f"  体外读值: 5 min 内 ≥1-Ub 修饰底物占 {conj_vitro:.1f} %"
          f" (平均链长 {mean_len_vitro:.2f})  —— '泛素化极强'")
    print(f"  体内读值: 24 h 降解 Dmax = {met['Dmax_pct']:.2f} %"
          f" (偶联尝试/底物 = {met['events_per_sub']:.0f}) —— '几乎不降解'")
    print("  解释: 体外无 DUB/26S, 修饰只增不减故累积; "
          "体内同链被 DUB 剪回, 且 >=4 (K48型) 链不形成, 净降解≈0。\n")
    return dict(conj_vitro=conj_vitro, mean_len_vitro=mean_len_vitro,
                Dmax_cell=met["Dmax_pct"], events_cell=met["events_per_sub"])


# ==========================================================================
# 图像绘制
# ==========================================================================
# 链长配色(跨图一致): U1..U4
C_U = {1: "#4C72B0", 2: "#55A868", 3: "#C44E52", 4: "#8172B3"}
C_S = "#3B3B3B"
C_X = "#000000"
C_DUB = ["#2a6f97", "#61a5c2", "#89c2d9"]


def _species(t, y, p):
    """返回按链长聚类的物种 nM: S(free U0), Btot, U1..U4, X, N, D."""
    Btot = sum(y[IB0 + k] for k in range(5))
    U = {i: y[IB0 + i] + y[IF1 + i - 1] for i in range(1, 5)}
    return (y[IS], Btot, U, y[IX], y[IN], y[ID])


_SWEEP = {}
def run_sweep():
    """k_off x DUB 网格扫描, 缓存结果用于热图/诊断。"""
    global _SWEEP
    if _SWEEP:
        return _SWEEP
    koff = np.logspace(-6.0, 0.0, 41)
    dub = 2.0 ** np.linspace(-3.0, 3.0, 17)
    dmax = np.empty((len(koff), len(dub)))
    mean = np.empty_like(dmax); short = np.empty_like(dmax)
    ev = np.empty_like(dmax); tet = np.empty_like(dmax)
    for i, k in enumerate(koff):
        for j, d in enumerate(dub):
            p = default_params(koff=float(k), dub_fold=float(d))
            _, y = solve(p)
            mt = metrics(y[:, -1], p)
            dmax[i, j] = mt["Dmax_pct"]
            mean[i, j] = mt["mean_len"]
            short[i, j] = mt["short_frac"]
            ev[i, j] = mt["events_per_sub"]
            tet[i, j] = mt["tetra_per_sub"]
    _SWEEP = dict(koff=koff, dub=dub, dmax=dmax, mean=mean,
                  short=short, ev=ev, tet=tet)
    return _SWEEP


def fig_heatmap(path="fig1_degradation_heatmap.png"):
    """图1: (k_off/停留时间) x (DUB 活性) 的 24h 降解效率二维热图。"""
    sw = run_sweep()
    koff, dub = sw["koff"], sw["dub"]
    kCSN = default_params()["kCSN"]
    dwell = 1.0 / (koff + kCSN)
    # 升序 x 轴: 短停留(弱/快解离) -> 长停留(超紧密/慢解离)
    order = np.argsort(dwell)
    dw = dwell[order]
    z = sw["dmax"][order, :].T           # (ny, nx)
    xlog = np.log10(dw)
    ylog = np.log2(dub)

    fig, ax = plt.subplots(figsize=(8.6, 6.2))
    im = ax.imshow(z, origin="lower", aspect="auto", cmap="viridis",
                   extent=[xlog[0], xlog[-1], ylog[0], ylog[-1]],
                   vmin=0, vmax=100, interpolation="nearest")
    # 轮廓(淡化), 其中 20% 强调并进入图例
    for lev, col in zip([5, 50, 80, 99], ["white", "#ff9f1c", "#ef476f",
                                          "#b5179e"]):
        ax.contour(xlog, ylog, z, levels=[lev], colors=[col],
                   linewidths=0.9, linestyles="--", alpha=0.7)
    c20 = ax.contour(xlog, ylog, z, levels=[20.0], colors=["#ffd166"],
                     linewidths=2.4)
    # 生理 DUB 水平线
    ax.axhline(0.0, color="#555", lw=1.2, ls=":")
    ax.text(xlog[2], 0.14, "physiological DUB = 1x", color="#555", fontsize=9)
    # 窗口中心 与 团队主张参数点
    pG = default_params(koff=4e-3)
    tauG = 1.0 / (pG["koff"] + pG["kCSN"])
    star = ax.plot(np.log10(tauG), 0.0, "*", ms=17, color="#03fcd7", mec="#003",
                   zorder=6, label="金发姑娘窗口中心 k_off=4e-3 s$^{-1}$")[0]
    pT = default_params(koff=1e-5)
    tauT = 1.0 / (pT["koff"] + pT["kCSN"])
    iT = int(np.argmin(np.abs(dw - tauT)))
    j1 = int(np.argmin(np.abs(dub - 1.0)))
    xm = ax.plot(np.log10(tauT), 0.0, "X", ms=15, mew=2.6, color="#111",
                 zorder=7, label="团队主张点 (Kd~2 pM, k_off=1e-5 s$^{-1}$)")[0]
    ax.annotate("该主张点 24 h Dmax = %.1f %%" % sw["dmax"][order[iT], j1],
                (np.log10(tauT) - 0.06, 0.42), fontsize=10, color="#222",
                fontweight="bold", ha="right")
    # 几何锁死/拓扑失效区(停留 >= ~600 s)
    ax.axvspan(np.log10(600.0), xlog[-1], color="red", alpha=0.10, zorder=0)
    ax.text(xlog[-1] - 0.12, 1.85, "几何锁死 /\n链拓扑失效区",
            rotation=90, va="center", ha="right", fontsize=9, color="#8a0f0f")
    from matplotlib.lines import Line2D
    c20_proxy = Line2D([], [], color="#ffd166", lw=2.4, ls="-")
    ax.legend(handles=[star, xm, c20_proxy],
              labels=[star.get_label(), xm.get_label(),
                      "Dmax = 20% 等值线"],
              loc="upper left", fontsize=9, framealpha=0.92)

    ax.set_xlabel(r"有效三元复合物停留时间  $\tau=1/(k_{\rm off}+k_{\rm CSN})$  (s)"
                  "\n右侧 = 超紧密 / 极慢 k_off (Kd → pM)")
    ax.set_ylabel("去泛素化酶活性倍数 (相对生理 DUB)")
    ax.set_title("24 h 降解效率  Dmax (%)  ——  三元复合物寿命 × DUB 活性矩阵\n"
                 "(分子胶对 TF-X; 生理浓度 CRL4$^{CRBN}$、内源 DUB 竞争)")
    ax.set_xticks(np.log10([1, 3, 10, 30, 100, 300, 1000, 2000]))
    ax.set_xticklabels(["1", "3", "10", "30", "100", "300", "1k", "2k"])
    ax.set_yticks(np.log2([0.25, 0.5, 1, 2, 4, 8]))
    ax.set_yticklabels(["0.25x", "0.5x", "1x", "2x", "4x", "8x"])
    ax.legend(loc="upper left", fontsize=9, framealpha=0.9)
    cb = fig.colorbar(im, ax=ax, extend="max")
    cb.set_label("降解效率  Dmax (%, 24 h)")
    fig.tight_layout()
    fig.savefig(path, dpi=170)
    plt.close(fig)
    return path


def fig_timecourses(path="fig2_chain_species_timecourse.png"):
    """图2: 不同泛素链长物种(U0..U4)与降解量 X 的非稳态时间历程(对数时间轴)."""
    sols = named_solutions()
    names = list(sols.keys())
    fig, axes = plt.subplots(2, 2, figsize=(12, 9), sharex=True)
    for ax, (name, (t, y, p)) in zip(axes.ravel(), sols.items()):
        S, Btot, U, X, N, D = _species(t, y, p)
        tmin = t / 60.0
        floor = 2e-3
        for i in (1, 2, 3, 4):
            ax.semilogy(tmin, np.clip(U[i], floor, None), color=C_U[i],
                        lw=1.6, label=f"U{i}  ({i}-Ub, 游离+结合)")
        ax.semilogy(tmin, np.clip(S, floor, None), color=C_S, lw=2.2,
                    ls="-", label="U0 (游离未修饰 TF-X)")
        ax.semilogy(tmin, np.clip(Btot, floor, None), color="#b0bec5", lw=1.2,
                    ls=":", label="B (三元复合物总)")
        ax.semilogy(tmin, np.clip(X, floor, None), color=C_X, lw=2.6,
                    ls="--", label="X (已被 26S 降解)")
        ax.set_ylim(floor, 4e2)
        ax.set_title(name + f"   |  Dmax(24h)={metrics(y[:, -1], p)['Dmax_pct']:.1f}%",
                     fontsize=10)
        ax.grid(True, which="both", alpha=0.25)
        ax.legend(fontsize=7, ncol=2, loc="upper right")
        ax.set_ylabel("丰度 (nM, 对数)")
        ax.set_xlabel("时间 (min)")
        ax.text(0.02, 0.03, "(底部虚线 = 不可检测阈值)", transform=ax.transAxes,
                fontsize=7, color="#777")
    fig.suptitle("泛素链长物种非稳态时间历程: 金发姑娘 vs 窗口边缘 vs 超紧密"
                 "(几何锁死)——链长被冻结在 U1/U2, ≥4 链几乎不形成",
                 fontsize=12)
    fig.tight_layout(rect=[0, 0, 1, 0.97])
    fig.savefig(path, dpi=170)
    plt.close(fig)
    return path


def fig_diagnostics(path="fig3_futile_diagnostics.png"):
    """图3: (a)泛素化通量-降解解耦  (b)无益耗能ATP  (c)链长快照 (d)沿k_off拓扑切片。"""
    sols = named_solutions()
    names = list(sols.keys())
    S0 = default_params()["S0"]; E3t = default_params()["E3tot"]
    mets = {nm: metrics(y[:, -1], p) for nm, (t, y, p) in sols.items()}

    fig, axs = plt.subplots(2, 2, figsize=(13.5, 9.5))

    # ---- (a) 解耦: 偶联通量(高) vs 降解(低)
    ax = axs[0, 0]
    xs = np.arange(len(names))
    dvals = [mets[n]["Dmax_pct"] for n in names]
    evals = [mets[n]["events_per_sub"] for n in names]
    ax.bar(xs, dvals, width=0.55, color="#2a6f97", label="Dmax, 24h (%)")
    ax.set_ylabel("Dmax (%)", color="#2a6f97")
    ax.set_ylim(0, 110)
    ax2 = ax.twinx()
    ax2.plot(xs, np.log10(np.maximum(evals, 1e-3)), "o-", color="#d55e00",
             label="log10(偶联尝试/底物)")
    ax2.set_ylabel("log10(累积偶联尝试 每底物)", color="#d55e00")
    ax2.set_ylim(-0.5, 4.2)
    ax.set_xticks(xs); ax.set_xticklabels([n.split("  ")[0] for n in names],
                                          rotation=18, ha="right", fontsize=8)
    ax.set_title("(a) 泛素化通量 与 净降解 的解耦\n"
                 "超紧密: 偶联通量最高 却几乎不降解 (体外强/胞内无)")
    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, fontsize=8, loc="upper left")

    # ---- (b) 无益耗能 ATP 核算
    ax = axs[0, 1]
    conj = [2.0 * mets[n]["events_per_sub"] for n in names]     # 偶联ATP/底物
    ned = [2.0 * (y[ICN][-1] / E3t) * (E3t / S0)
           for n, (t, y, p) in sols.items()]
    prot = [ATP_PRO * mets[n]["Dmax_pct"] / 100.0 for n in names]
    bot = np.zeros(len(names))
    ax.bar(xs, conj, bottom=bot, color="#d55e00", label="偶联(E2~Ub) ATP")
    bot = bot + np.array(conj)
    ax.bar(xs, ned, bottom=bot, color="#55A868", label="NEDD8 化循环 ATP")
    bot = bot + np.array(ned)
    ax.bar(xs, prot, bottom=bot, color="#7f7f7f", label="26S 降解 ATP")
    ax.set_yscale("log"); ax.set_ylim(1e-1, 1e6)
    ax.set_xticks(xs); ax.set_xticklabels([n.split("  ")[0] for n in names],
                                          rotation=18, ha="right", fontsize=8)
    ax.set_ylabel("每底物 ATP (对数)")
    for i, n in enumerate(names):
        mf = mets[n]["futile"]
        ax.annotate("无益指数∞" if mf == np.inf else f"×{mf:.0f}",
                    (xs[i], bot[i] * 1.6), ha="center", fontsize=8,
                    color="#8a0f0f", fontweight="bold")
    ax.set_title("(b) 无益耗能循环: 偶联/NEDD8 ATP 大量空转\n"
                 "超紧密下几乎全部 ATP 无对应降解产物 (无益指数 = 偶联/最少需要)")
    ax.legend(fontsize=8, loc="upper left")

    # ---- (c) 60 min 泛素链长组成快照 (绝对 nM 堆叠; 避免小池被归一化放大)
    ax = axs[1, 0]
    tq = 3600.0
    mats = []
    for nm, (t, y, p) in sols.items():
        k = int(np.argmin(np.abs(t - tq)))          # 快照: 60 min
        _, _, U, _, _, _ = _species(t[k], y[:, k], p)
        mats.append(np.array([U[i] for i in (1, 2, 3, 4)]))
    mats = np.array(mats)
    totals = mats.sum(axis=1)
    xs = np.arange(len(names))
    prev = np.zeros(len(names))
    for i in (1, 2, 3, 4):
        ax.bar(xs, mats[:, i - 1], bottom=prev, width=0.55,
               color=C_U[i], label=f"{i}-Ub")
        prev = prev + mats[:, i - 1]
    ax.set_xticks(xs)
    ax.set_xticklabels([n.split("  ")[0] for n in names], rotation=18,
                       ha="right", fontsize=8)
    ax.set_ylim(0, 100)
    ax.set_ylabel("泛素化底物按链长分布 (nM, t = 60 min)")
    for i in range(len(names)):
        ax.text(xs[i], totals[i] + 1.5, f"总池 {totals[i]:.1f} nM",
                ha="center", fontsize=8)
    ax.set_title("(c) 60 min 泛素链长组成: 超紧密 = 单泛素(U1)主导\n"
                 "~88 nM 底物被锁在 mono/短链, ≥4 链 (U4) 几乎为 0")
    ax.legend(fontsize=8, ncol=4, loc="upper center",
              bbox_to_anchor=(0.5, -0.06))

    # ---- (d) 沿 k_off 的拓扑切片 (DUB = 1x & 3x)
    ax = axs[1, 1]
    sw = run_sweep()
    koff, dub = sw["koff"], sw["dub"]
    kCSN = default_params()["kCSN"]
    dwell = 1.0 / (koff + kCSN)
    j1 = int(np.argmin(np.abs(dub - 1.0)))
    j3 = int(np.argmin(np.abs(dub - 3.0)))
    ax.axvspan(600.0, dwell.max(), color="red", alpha=0.10)
    ax.text(750, 4.0, "几何锁死区", fontsize=9, color="#8a0f0f")
    l1, = ax.semilogx(dwell, sw["dmax"][:, j1], color=C_DUB[0], lw=2.2,
                      label="Dmax, DUB 1x")
    l2, = ax.semilogx(dwell, sw["dmax"][:, j3], color=C_DUB[2], lw=2.2, ls="--",
                      label="Dmax, DUB 3x")
    ax.axhline(20, color="#8a0f0f", lw=1, ls=":")
    ax.text(1.5, 21, "Dmax = 20% 阈值", fontsize=8, color="#8a0f0f")
    ax.set_xscale("log"); ax.set_xlim(1, 2000)
    ax.set_xlabel("有效停留时间 τ (s)  → 超紧密")
    ax.set_ylabel("Dmax (%)")
    ax2 = ax.twinx()
    (l3,) = ax2.semilogx(dwell, sw["tet"][:, j1], color="#5a189a", lw=1.8,
                         ls="-.")
    ax2.set_ylabel("≥4链形成事件 / 底物 (24 h)", color="#5a189a")
    ax2.set_ylim(0, 8)
    ax.legend([l1, l2, l3],
              ["Dmax, DUB 1x", "Dmax, DUB 3x", "≥4链形成事件/底物 (24h)"],
              fontsize=8, loc="center right")
    ax.set_title("(d) 沿停留时间的降解/拓扑切片:\n"
                 "超紧密端越过锁死阈值后 Dmax 崩溃(<20%) 且 ≥4链几乎不再形成")

    fig.suptitle("无益循环与泛素链拓扑失效诊断 (ODE 模型, 24 h)", fontsize=13)
    fig.tight_layout(rect=[0, 0, 1, 0.97])
    fig.savefig(path, dpi=170)
    plt.close(fig)
    return path


if __name__ == "__main__":
    import time
    t0 = time.time()
    print("[1/4] scenario table ...")
    scenario_table()
    in_vitro_cell_contrast()
    print("[2/4] 2-D degradation heatmap ...")
    fig_heatmap()
    print("[3/4] chain-length species time course ...")
    fig_timecourses()
    print("[4/4] futile-cycle diagnostics ...")
    fig_diagnostics()
    print(f"\nAll figures written. elapsed {time.time()-t0:.1f} s")
