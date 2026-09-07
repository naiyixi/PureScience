#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
 llps_condensate_phase_transition_sim.py
================================================================================
对抗性物证模拟：
靶向超增强子转录凝聚体的多价小分子 (CPD-X，双芳基多价聚集分子) 在活细胞核内
由"非平衡相分离固化与共沉淀隔离 (Gelation-Trap Escape)" 诱发表观耐药/毒性
暴发的多相物理场审查。

情景与宣称 (Hypothetical, 据任务书)：
  CPD-X 在体外对超增强子转录凝聚体 (MED1/致癌 TF) 分配系数 P>300，FRAP 恢复
  时间显著延长。管线据此宣称：可在超低剂量于相内形成毫摩尔级局部超饱和，经
  竞争疏水/芳香堆叠位点将致癌转录无序网络"彻底溶解化"，永久关闭全基因组致癌
  程序，"绝不存在耐药/代偿逃逸"。

本程序从多相物理场角度给出裁决性反证 (非平衡固化陷阱)：
  1) 三元 Flory-Huggins 热力学 + 逾渗/凝胶化：高 P 药物浓缩入相**加深**而非
     抹平稠相自由能阱；多价桥接在低占据率 (凝胶点 p_c≈1/(f-1)) 即逾渗成网，
     先于任何"溶解"所需的热力学条件；渗透网络 + 玻璃化把液滴固化成玻璃/纤维
     态，内部流动度崩塌，转录网络被"冻结保留"而非被删除。
  2) 耦合 Cahn-Hilliard 相场 (phi) + 药物浓度场 (c) + 桥接占据场 (theta) 的
     1D 时空 PDE + 逾渗刚度 + 内部有效扩散率 D_eff(theta) 衰减 + 全细胞抑癌
     转录活性响应。灌注 0-48 h。
  3) 剂量扫掠：抑癌因子 (p53/共激活因子/蛋白酶体) 被固化网络非特异性共沉淀
     隔离 (Sequestration Trap) => 促凋亡通道旁路 => 存活率"反向倒 U 型"耐药
     耐受曲线，而致癌转录反常维持。

单位约定：长度 [um]，时间 [h]，浓度 [c.u.]。D_c 为含可逆结合延迟的有效扩散
系数；与物理值换算见研报 Methods。

输出文件 (与脚本同目录)：
  fig_thermo_phase_diagram.png   三元 FH 自由能/自旋分解线/凝胶-溶解窗
  fig_curing_heatmaps.png        log10(D_eff/D_in0) 液->固 时空热图 (低/中/高剂量)
  fig_state_diagram.png          Liquid/Gel/Glass 状态体积分数 vs 时间
  fig_radial_profiles.png        径向 D_eff 剖面快照
  fig_dose_response.png          固化体积/致癌转录/抑癌活性/存活率倒 U
  dose_response.csv              剂量-效应数值表
  simulation_diagnostics.json    关键判决数值

运行: python3 llps_condensate_phase_transition_sim.py
================================================================================
"""
import os
import json
import csv
import numpy as np
from scipy.linalg import solve_banded
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import cm

OUTDIR = os.path.dirname(os.path.abspath(__file__))

# =============================================================================
#  I. 参数表
# =============================================================================
class P:
    # ---- 网格 / 几何 ---------------------------------------------------------
    L  = 10.0          # 域长 [um]；凝聚体液滴居中，两侧核质池
    N  = 512
    xc = 5.0
    a  = 1.15          # 液滴半径 [um]
    w  = 0.17          # 界面宽度 [um]
    # ---- 相组成 --------------------------------------------------------------
    phi_d = 0.42       # 凝聚体内骨架 (致癌TF/MED1/共激活因子)
    phi_s = 0.02       # 核质稀释相
    # ---- 输运 ----------------------------------------------------------------
    D_c   = 0.55       # 游离药物有效扩散系数(基值) [um^2/h]
    Rbar  = 7.0        # 固化基质对游离药物的输运屏障强度:
                       #   D_c,eff(theta)=D_c*exp(-Rbar*g), g=(theta-theta_c)/
                       #   (theta_glass-theta_c), 反映结合态主导的自由药滞留/载流衰减
    D_phi = 0.03       # 凝聚体骨架内容物交换(液态) 迁移率系数
    kap   = 0.30       # Cahn-Hilliard 梯度能系数
    A_dw  = 60.0       # 双阱势强度 (凝聚相稳定性)
    k_env = 1.6        # 核质池灌注松弛率 [1/h] (无限库)
    t_on  = 0.8        # 药物浓度上升时间常数 [h]
    # ---- CPD-X 多价桥接 (Hill-2 有效两臂) ------------------------------------
    k_a  = 0.9         # 正向速率 [1/(c.u.^2 h)]
    Kd   = 1.00        # 表观解离浓度 [c.u.]：theta_eq = c^2/(c^2 + Kd^2)
    Ws   = 2.4         # 骨架单位密度下粘性结合位点容量 [c.u.]
    # ---- 状态阈值 ------------------------------------------------------------
    theta_c      = 0.28   # 逾渗凝胶点 (f≈4.6 结合臂, p_c≈1/(f-1))
    theta_trap   = 0.42   # 非特异性共沉淀隔离(陷阱)阈值
    theta_glass  = 0.68   # 玻璃化阈值 (D_eff 大幅衰减/固化)
    theta_dis    = 0.95   # 转录机器玻璃化失活占据率 (凝胶保留活性机器)
    # ---- 全细胞响应 ----------------------------------------------------------
    lam_ts  = 3.2     # 陷阱体积 -> 抑癌活性损失耦合
    k_apo   = 0.020   # p53 通路健全时的促凋亡速率 [1/h]
    k_tox   = 0.050   # 玻璃化/超高剂量全细胞毒性系数 [1/h]
    dep_rep = 0.85    # 去抑制强度 (抑癌活性损失 -> 致癌负反馈移除)
    c_tox   = 1.4     # 毒性剂量阈值 [c.u.]
    c_hi    = 3.6     # 剂量刻度上界 [c.u.]
    # ---- 时间 / 扫掠 ---------------------------------------------------------
    dt = 0.005        # [h]
    T  = 48.0         # [h]
    hist_every = 0.5  # 历史存帧间隔 [h]
    # 剂量扫掠 [c.u.] (包含 0 基线)
    DOSES = [0.0, 0.40, 0.60, 0.75, 0.90, 1.10, 1.40, 1.90, 2.60, 3.60]
    DOSE_LOW, DOSE_MID, DOSE_HIGH = 0.60, 1.10, 2.60


# =============================================================================
#  II. 三元 Flory-Huggins 热力学 + 逾渗  (裁决第 1 部分)
# =============================================================================
def fh_free_energy(phi, c, chi_ps, chi_pd, chi_ds, Np=8.0):
    """三元 FH 自由能密度 [kBT/lattice site]。phi+c+s=1。"""
    phi = np.asarray(phi, float); c = np.asarray(c, float)
    s = np.clip(1.0 - phi - c, 1e-8, None)
    phi = np.clip(phi, 1e-8, None); c = np.clip(c, 1e-8, None)
    ent = (phi/Np)*np.log(phi) + c*np.log(c) + s*np.log(s)
    cnt = chi_ps*phi*s + chi_pd*phi*c + chi_ds*c*s
    return ent + cnt


def fh_spinodal_ternary(phi_grid, chi_ps, chi_pd, chi_ds, Np=8.0):
    """三元自旋分解线：det(Hess)=0，对每个 phi 解不稳定 c 区间 [c_lo, c_hi]。"""
    phi = np.asarray(phi_grid, float)
    n = phi.size
    c_lo = np.full(n, np.nan); c_hi = np.full(n, np.nan)
    for i, p0 in enumerate(phi):
        if not (0.0 < p0 < 1.0):
            continue
        cg = np.linspace(1e-6, 1.0 - p0 - 1e-6, 1200)
        if cg.size < 8:
            continue
        s = 1.0 - p0 - cg
        f_cc = 1.0/cg + 1.0/s - 2.0*chi_ds
        f_pp = 1.0/(8.0*p0) + 1.0/s - 2.0*chi_ps
        f_pc = -1.0/s + (chi_pd - chi_ps) - chi_ds
        det = f_pp*f_cc - f_pc*f_pc
        neg = det < 0
        if not neg.any():
            continue
        idx = np.flatnonzero(neg)
        brk = np.flatnonzero(np.diff(idx) > 1)
        seg0 = np.concatenate([[idx[0]], idx[brk + 1]])
        seg1 = np.concatenate([idx[brk], [idx[-1]]])

        def edge(j0, j1):
            c0, c1, d0, d1 = cg[j0], cg[j1], det[j0], det[j1]
            if d0*d1 <= 0:
                return c0 - d0*(c1 - c0)/(d1 - d0)
            return 0.5*(c0 + c1)
        widths = seg1 - seg0
        k = int(np.argmax(widths))
        c_lo[i] = edge(seg0[k], seg0[k] + 1)
        c_hi[i] = edge(seg1[k] - 1, seg1[k])
    return phi, c_lo, c_hi


def gel_point(f):
    """Flory-Stockmayer 平均场凝胶点占据率 p_c = 1/(f-1)。"""
    return 1.0/(f - 1.0)


def theta_for_dissolution(chi_eff_fn, chi_crit, th_grid):
    """把有效 chi 压到临界值以下所需的占据率 theta_dis；不可达返回 (None,chi_end)。"""
    th = np.asarray(th_grid, float)
    ce = chi_eff_fn(th)
    if not np.any(ce < chi_crit):
        return None, float(ce[-1])
    k = int(np.flatnonzero(ce < chi_crit)[0])
    t0, t1 = th[k-1], th[k]
    e0, e1 = ce[k-1], ce[k]
    return float(t0 + (chi_crit - e0)*(t1 - t0)/(e1 - e0)), float(chi_crit)


# =============================================================================
#  III. 一维耦合 Cahn-Hilliard + 凝胶化动力学求解器
# =============================================================================
class CuringSim:
    """凝聚体固化/陷阱时空动力学。

    场变量：
      phi(x,t)    骨架密度场  ->  Cahn-Hilliard (双阱势 + 梯度能谱隐式, 保守)
      c(x,t)      游离药物浓度场 -> 结合消耗 + 核质池灌注 + 谱隐式扩散
      theta(x,t)  桥接位点占据率 -> Hill-2 多价, 解析精确松弛
    关键数值装置：
      - 固化区 (theta>=theta_c) 骨架被钳制 => 网络"不可解离" (动力学陷阱),
        液滴不解体(留存); 公司宣称的"永久溶解删除"不发生。
      - 凝胶/玻璃化 -> 内容物有效扩散率 D_eff(theta) 指数崩塌。
    """
    def __init__(self, par):
        self.p = par
        self.x = np.linspace(0, par.L, par.N, endpoint=False)
        self.dx = self.x[1] - self.x[0]
        self.k = 2*np.pi*np.fft.fftfreq(par.N, self.dx)
        self.k2 = self.k**2
        self.k4 = self.k2**2
        r = np.abs(self.x - par.xc)
        self.r = r
        self.phi0 = par.phi_s + (par.phi_d - par.phi_s) \
            * 0.5*(1.0 - np.tanh((r - par.a)/par.w))
        self.env_mask = (self.phi0 < 0.06).astype(float)   # 核质池(稀释相)
        self.scaf_mask = (self.phi0 > 0.03).astype(float)  # 凝聚体骨架区
        self.site_cap = par.Ws*np.clip(self.phi0, 0, None)
        self.in_drop = (r <= par.a + 2*par.w)

    # ----------------------------------------- 算子
    def _relax_theta(self, th, c, dt):
        """Hill-2 桥接占据：dth/dt = k_a[c^2(1-th) - th Kd^2]
        -> theta_eq = c^2/(c^2+Kd^2)，解析精确松弛 (c 在子步内冻结)。"""
        p = self.p
        c2 = c**2
        den = c2 + p.Kd**2
        th_eq = c2/den
        th_new = th_eq + (th - th_eq)*np.exp(-p.k_a*den*dt)
        return np.where(self.scaf_mask > 0.5, np.clip(th_new, 0.0, 1.0), th)

    def _diffuse_var_implicit(self, c, dt, D0, th):
        """可变系数隐式扩散 (向后欧拉, 无条件稳定; 变系数用界面调和平均)。

        固化区 (theta>theta_c) 中结合态主导、自由药输运强烈滞留:
          D_c,eff(theta) = D0*exp(-Rbar*g),  g=clip((theta-theta_c)/
          (theta_glass-theta_c),0,1)
        后果: 已固化的凝胶/玻璃壳成为药物进一步侵入的扩散屏障 -> 固化前沿
        自限制, 形成"固化壳-未固化活性核"结构 (自我封闭的 trap)。
        """
        p = self.p
        g = np.clip((th - p.theta_c)/(p.theta_glass - p.theta_c), 0.0, 1.0)
        D = D0*np.exp(-p.Rbar*g)
        Dhm = 2.0*D[:-1]*D[1:]/(D[:-1] + D[1:] + 1e-300)   # 界面调和平均
        f = dt/(self.dx*self.dx)
        N = c.size
        ab = np.zeros((3, N))
        ab[1, :] = 1.0
        ab[1, 0]    += f*Dhm[0]
        ab[1, 1:-1] += f*(Dhm[:-1] + Dhm[1:])
        ab[1, -1]   += f*Dhm[-1]
        # scipy 带状存储: ab[u+i-j, j] = A[i,j], u=1
        ab[2, :N-1] = -f*Dhm          # 次对角
        ab[0, 1:]   = -f*Dhm          # 主对角上
        return solve_banded((1, 1), ab, c)

    def _phi_ch_step(self, phi, th, c, dt):
        """Cahn-Hilliard 一步（双阱势驱动，梯度能线性隐式，固化区钳制）。

        dphi/dt = M div grad(mu)， mu = df/dphi - kap d2phi/dx2
        谱半隐式：对 -M*kap*d4phi 项隐式，稳定；非线性 df/dphi 显式。
        """
        p = self.p
        phi_old = phi.copy()
        # 双阱势: f = (A_dw/2)(phi-phi_s)^2 (phi-phi_d)^2  -> 两井等高,
        # 故与初始组成匹配的液滴处于稳态 (保守 C-H 不使其收缩/扩展)。
        s_, d_ = p.phi_s, p.phi_d
        df = p.A_dw*(phi - s_)*(phi - d_)*(2*phi - s_ - d_)
        dfhat = np.fft.fft(df)
        fhat = np.fft.fft(phi_old)
        den = 1.0 + dt*p.D_phi*p.kap*self.k4
        ph_new = np.real(np.fft.ifft((fhat - dt*p.D_phi*self.k2*dfhat)/den))
        # 固化(逾渗/玻璃化)区骨架被网络锁定 -> 位置冻结 (动力学陷阱)
        gel = (th >= p.theta_c).astype(float)
        ph_new = np.where(gel > 0.5, phi_old, ph_new)
        # 数值质量守恒微修 (零模不变, 仅余数值误差)
        ph_new = ph_new + (np.mean(phi_old) - np.mean(ph_new))
        return np.maximum(ph_new, 1e-4)

    # ----------------------------------------- 主积分
    def run(self, dose, hist_every=None):
        p = self.p
        hist_every = hist_every or p.hist_every
        c_res = float(dose)
        nstep = int(round(p.T/p.dt))
        nh = max(1, int(round(hist_every/p.dt)))

        phi = self.phi0.copy()
        c = np.zeros_like(phi)
        th = np.zeros_like(phi)
        ts = [0.0]; hphi = [phi.copy()]; hth = [th.copy()]
        hgel = [np.zeros_like(phi)]

        if c_res <= 1e-9:     # 无药基线：不固化
            return {"t": np.array(ts), "x": self.x,
                    "phi_hist": np.asarray(hphi), "theta_hist": np.asarray(hth),
                    "gel_hist": np.asarray(hgel), "phi_final": phi,
                    "c_final": c, "theta_final": th}

        for n in range(1, nstep + 1):
            t = n*p.dt
            th_old = th
            # --- (1) 桥接占据 Hill-2 (解析精确) ---
            th = self._relax_theta(th, c, p.dt)
            # --- (2) 游离药物: 结合消耗 + 核质池灌注 + 隐式扩散 ---
            dth = th - th_old
            c = c - 2.0*self.site_cap*np.maximum(dth, 0.0)   # 每桥占 2 位点
            c_res_t = c_res*(1.0 - np.exp(-t/p.t_on))        # 灌注上升
            c = c + p.dt*p.k_env*self.env_mask*(c_res_t - c)
            c = self._diffuse_var_implicit(c, p.dt, p.D_c, th)  # 可变系数扩散
            c = np.maximum(c, 0.0)
            # --- (3) 骨架相场 Cahn-Hilliard (固化区冻结) ---
            phi = self._phi_ch_step(phi, th, c, p.dt)
            # --- 存帧 ---
            if n % nh == 0 or n == nstep:
                ts.append(t); hphi.append(phi.copy()); hth.append(th.copy())
                hgel.append((th >= p.theta_c).astype(float))

        return {"t": np.array(ts), "x": self.x,
                "phi_hist": np.asarray(hphi), "theta_hist": np.asarray(hth),
                "gel_hist": np.asarray(hgel),
                "phi_final": phi, "c_final": c, "theta_final": th}


# =============================================================================
#  IV. 后处理: D_eff / 状态 / 全细胞响应
# =============================================================================
def D_eff_ratio(theta, par):
    """凝聚体内部内容物有效扩散率：
    D_eff/D_in0 = exp(-6.5 * (theta-theta_c)/(1-theta_c))
    (逾渗后每个数量级桥接超额 -> 流动度 ~10x 降低; 玻璃化共 >3 个数量级)。"""
    g = np.maximum(0.0, (theta - par.theta_c)/np.maximum(1e-9, 1.0 - par.theta_c))
    return np.exp(-6.5*g)


def classify(theta, par):
    cl = np.zeros_like(theta, dtype=int)
    cl[theta >= par.theta_c] = 1
    cl[theta >= par.theta_glass] = 2
    return cl


def analyze_run(res, par, dose):
    """48h 终态宏观指标。"""
    ind = (np.abs(res["x"] - par.xc) <= par.a + 2*par.w)
    th = res["theta_final"]; phi = res["phi_final"]
    cl = classify(th, par)
    n = int(ind.sum())
    Vgel = float((cl[ind] >= 1).sum()/n)
    Vglass = float((cl[ind] >= 2).sum()/n)
    Vtrap = float((th[ind] >= par.theta_trap).sum()/n)
    # ---- 致癌转录输出: 活性窗 a(theta); 凝胶仍保留装配好的机器 ----
    a = np.exp(-(th/par.theta_dis)**2)
    O_raw = float(np.sum((a*phi)[ind])/max(np.sum(phi[ind]), 1e-9))
    TS_loss = 1.0 - np.exp(-par.lam_ts*Vtrap)
    TS_active = float(1.0 - TS_loss)
    dep = 1.0 + par.dep_rep*TS_loss
    O_net = float(min(1.5, O_raw*dep))
    # ---- 存活率: 促凋亡(p53 健全) + 全细胞毒性(玻璃化/超剂量) ----
    kA = par.k_apo*TS_active
    toxV = float(np.clip((Vglass - 0.05)/0.5, 0, 1))       # 玻璃体积毒性分量
    toxD = float(np.clip((dose - par.c_tox)/(par.c_hi - par.c_tox), 0, 1))
    kT = par.k_tox*(0.6*toxV + 0.4*toxD)                   # 高剂量毒性分量
    S = float(np.clip(np.exp(-(kA + kT)*par.T), 0, 1))
    # ---- 液滴骨架留存率 (不解体, 反驳"溶解删除") ----
    ret = float(np.sum(phi[ind])/max(np.sum(res["phi_hist"][0][ind]), 1e-9))
    de = float(D_eff_ratio(th, par)[ind].mean())
    return {"dose": float(dose), "Vgel": Vgel, "Vglass": Vglass, "Vtrap": Vtrap,
            "O_raw": O_raw, "O_net": O_net, "TS_active": TS_active,
            "Survival": S, "retention": ret, "D_eff_core": de}


# =============================================================================
#  V. 图件
# =============================================================================
def _save(fig, name):
    fig.savefig(os.path.join(OUTDIR, name), dpi=160, bbox_inches="tight")
    plt.close(fig)
    print("saved figure:", name)


def figure_thermo(par):
    chi_ps, chi_pd, chi_ds = 1.9, -0.5, 0.15
    chi_crit = 0.5*(1.0/np.sqrt(8.0) + 1.0)**2
    fig, ax = plt.subplots(1, 3, figsize=(18, 5.0))

    # ---- (A) 三元 FH 自由能井 vs 药物占据 (theta) ----
    phi = np.linspace(0.003, 0.95, 700)
    cc = 0.02
    cmap = cm.plasma(np.linspace(0, 0.9, 4))
    fbase = fh_free_energy(phi, cc, chi_ps, chi_pd, chi_ds, 8.0)
    fbase = fbase - fbase[0]
    ax[0].plot(phi, fbase, lw=2.0, color=cmap[0], label="no drug  ($\\theta$=0)")
    wells = []
    for j, theta in enumerate([0.30, 0.60, 0.95]):
        eta = 0.45
        chi_e = chi_ps*(1.0 - eta*theta)
        f = fh_free_energy(phi, cc, chi_e, chi_pd*(1 + 0.4*theta), chi_ds, 8.0)
        f = f - f[0]
        wells.append(f)
        ax[0].plot(phi, f, lw=1.8, color=cmap[j+1],
                   label=f"occupancy $\\theta$={theta:.2f}, "
                         f"$\\chi_{{eff}}$={chi_e:.2f}")
    ax[0].axhline(0, color="k", lw=0.6)
    ax[0].axvline(par.phi_d, color="k", ls=":", lw=1)
    ax[0].annotate("condensed-phase well  $\\phi_d$=0.42\ndeepens (more stable) as\nthe drug loads into the droplet",
                   xy=(par.phi_d, min(wells[-1][np.abs(phi-0.42) < 0.05].min(), -0.15)),
                   xytext=(0.62, -0.36), fontsize=8, color="k",
                   arrowprops=dict(arrowstyle="->", lw=1, color="k"))
    ax[0].set_xlabel("scaffold volume fraction $\\phi$")
    ax[0].set_ylabel("$f(\\phi)$  [$k_BT$/site]")
    ax[0].set_title("(A) Ternary FH wells: drug occupancy deepens —\n"
                    "concentrating the drug does NOT dissolve the condensed phase")
    ax[0].legend(fontsize=8)
    ax[0].set_ylim(-0.45, 0.22)

    # ---- (B) 三元自旋分解线 + 凝胶化边界 + 加载轨迹 ----
    phi_s = np.linspace(0.03, 0.60, 45)
    _, clo, chi_ = fh_spinodal_ternary(phi_s, chi_ps, chi_pd, chi_ds, 8.0)
    ax[1].plot(clo, phi_s, "-", color="tab:red", lw=2,
               label="ternary spinodal (low-$c$ branch)")
    ax[1].plot(chi_, phi_s, "--", color="tab:red", lw=1.2,
               label="ternary spinodal (high-$c$ branch)")
    c_gel = par.Kd*np.sqrt(par.theta_c/(1 - par.theta_c))
    ax[1].axvline(c_gel, color="tab:green", lw=2.4, ls="--",
                  label=f"gelation line (Percolation), c_gel={c_gel:.2f}")
    ax[1].axvspan(c_gel, 2.5, color="tab:green", alpha=0.08)
    ax[1].annotate("", xy=(2.30, 0.42), xytext=(0.15, 0.42),
                   arrowprops=dict(arrowstyle="->", lw=2.2, color="tab:blue"))
    ax[1].text(1.05, 0.53, "drug-loading trajectory\nof the droplet",
               fontsize=8, color="tab:blue", ha="center")
    ax[1].text(0.10, 0.18, "L-L coexistence\n(condensate)", fontsize=8, color="grey")
    ax[1].text(1.3, 0.08, "percolated gel / glass\n(arrested, non-dissolving)",
               fontsize=8, color="tab:green")
    ax[1].set_xlim(0, 2.5); ax[1].set_ylim(0, 0.62)
    ax[1].set_xlabel("free drug concentration $c$ [c.u.]")
    ax[1].set_ylabel("scaffold volume fraction $\\phi$")
    ax[1].set_title("(B) Ternary spinodal vs percolation gelation line:\n"
                    "gel line crossed before any melting window is reached")
    ax[1].legend(fontsize=8, loc="upper right")

    # ---- (C) 沿占据率的相态排序: 液态 -> 凝胶 -> 玻璃; 溶解窗位于凝胶之后或不可达 ----
    th = np.linspace(0, 1, 600)
    ax[2].axvspan(0, par.theta_c, color="#7fc97f", alpha=0.25)
    ax[2].axvspan(par.theta_c, par.theta_glass, color="#beaed4", alpha=0.30)
    ax[2].axvspan(par.theta_glass, 1.0, color="#fdc086", alpha=0.45)
    ax[2].text(0.13, 0.90, "liquid\nLLPS droplet", ha="center", fontsize=8)
    ax[2].text(0.47, 0.90, "percolated GEL\n(TF retained; FRAP↓↓)", ha="center", fontsize=8)
    ax[2].text(0.86, 0.90, "GLASS / fibril\n(mobility collapse)", ha="center", fontsize=8)
    # 凝胶点
    ax[2].axvline(par.theta_c, color="tab:green", lw=2.2)
    ax[2].text(par.theta_c+0.01, 0.70, "$\\theta_c$=0.28\ngelling here\n(p$_c$=1/(f-1), f≈4.6)",
               fontsize=8, color="tab:green")
    # 玻璃化阈值
    ax[2].axvline(par.theta_glass, color="tab:orange", lw=2.2)
    ax[2].text(par.theta_glass+0.01, 0.45, "$\\theta_{glass}$=0.68", fontsize=8,
               color="tab:orange")
    # 溶解窗: 强竞争(近似单价)在 theta~0.58 才能熔化; 多价高 P 药全程不可达
    thg = np.linspace(0.02, 0.99, 800)
    ce90 = chi_ps*(1 - 0.90*thg)
    k90 = int(np.flatnonzero(ce90 < chi_crit)[0])
    ax[2].axvline(thg[k90], color="tab:red", ls=":", lw=2.2)
    ax[2].text(thg[k90]+0.01, 0.30, f"only a strong, near-monovalent competitor\n"
               f"could 'melt' at $\\theta$={thg[k90]:.2f} (already > gel point)",
               fontsize=8, color="tab:red")
    ce45 = chi_ps*(1 - 0.45*thg)
    ax[2].text(0.40, 0.08, "multivalent high-$P$ drug ($\\eta$=0.45):\n"
               "$\\chi_{eff}$ never falls below $\\chi_{crit}$\n-> melting window UNREACHABLE",
               fontsize=8, color="tab:purple")
    ax[2].set_xlim(0, 1.0); ax[2].set_ylim(0, 1.0)
    ax[2].set_xlabel("site occupancy $\\theta$ inside condensate")
    ax[2].set_yticks([])
    ax[2].set_title("(C) Ordering along occupancy: gelation precedes, and blocks,\n"
                    "any dissolution; the condensate is kinetically locked")
    fig.tight_layout()
    _save(fig, "fig_thermo_phase_diagram.png")
    return chi_crit, c_gel


def figure_curing(par, runs):
    labels = {"low": "low dose = 0.60", "mid": "mid dose = 1.10",
              "high": "high dose = 2.60"}
    fig, axs = plt.subplots(1, 3, figsize=(17, 4.7), sharey=True)
    for ax, key in zip(axs, ["low", "mid", "high"]):
        res = runs[key]
        x = res["x"]; tt = res["t"]
        H = np.log10(np.maximum(D_eff_ratio(res["theta_hist"], par), 1e-4))
        im = ax.pcolormesh(x, tt, H, cmap="magma", vmin=-3.2, vmax=0.0,
                           shading="auto")
        gl = np.asarray(res["gel_hist"])
        ax.contour(x, tt, gl, levels=[0.5], colors="cyan", linewidths=1.1)
        ax.axvspan(par.xc - par.a, par.xc + par.a, color="white", alpha=0.12)
        ax.axvline(par.xc - par.a, color="w", ls=":", lw=0.8)
        ax.axvline(par.xc + par.a, color="w", ls=":", lw=0.8)
        ax.text(par.xc, 46.2, "condensate", color="white", ha="center",
                fontsize=8, alpha=0.9)
        ax.set_title(labels[key]); ax.set_xlabel("x [um]"); ax.set_ylim(0, par.T)
    axs[0].set_ylabel("time [h]")
    cbar = fig.colorbar(im, ax=axs, shrink=0.9, pad=0.015)
    cbar.set_label(r"$\log_{10}(D_{\mathrm{eff}}/D_{\mathrm{in},0})$")
    fig.suptitle("Liquid -> Gel -> Glass curing: collapse of condensate-internal "
                 "mobility over 48 h", y=1.03)
    fig.tight_layout()
    _save(fig, "fig_curing_heatmaps.png")


def figure_state_diagram(par, runs):
    labels = {"low": "low dose = 0.60", "mid": "mid dose = 1.10",
              "high": "high dose = 2.60"}
    fig, axs = plt.subplots(1, 3, figsize=(17, 4.5), sharey=True)
    for ax, key in zip(axs, ["low", "mid", "high"]):
        res = runs[key]
        x = res["x"]; tt = res["t"]
        ind = np.abs(x - par.xc) <= par.a + 2*par.w
        n = int(ind.sum())
        fL = []; fG = []; fS = []
        for th in res["theta_hist"]:
            cl = classify(th, par)
            fL.append((cl[ind] == 0).sum()/n)
            fG.append((cl[ind] == 1).sum()/n)
            fS.append((cl[ind] == 2).sum()/n)
        ax.stackplot(tt, fL, fG, fS,
                     labels=["Liquid", "Gel (percolated)", "Glass / solid"],
                     colors=["#7fc97f", "#beaed4", "#fdc086"])
        ax.set_title(labels[key]); ax.set_xlabel("time [h]"); ax.set_ylim(0, 1.02)
    axs[0].set_ylabel("condensate volume fraction")
    h, l = axs[0].get_legend_handles_labels()
    fig.legend(h, l, loc="lower center", ncol=3, fontsize=9, bbox_to_anchor=(0.5, -0.05))
    fig.suptitle("Solidification state diagram inside the condensate", y=1.02)
    fig.tight_layout()
    _save(fig, "fig_state_diagram.png")


def figure_radial(par, runs):
    fig, axs = plt.subplots(1, 2, figsize=(15, 5), sharey=True)
    for ax, key in zip(axs, ["mid", "high"]):
        res = runs[key]
        x = res["x"]; tt = res["t"]
        cols = cm.viridis(np.linspace(0.05, 0.95, 4))
        for tq, col in zip([1.0, 6.0, 24.0, 48.0], cols):
            j = int(np.argmin(np.abs(tt - tq)))
            de = np.log10(np.maximum(D_eff_ratio(res["theta_hist"][j], par), 1e-4))
            ax.plot(x, de, lw=1.7, color=col, label=f"t = {tt[j]:.0f} h")
        ax.axvspan(par.xc - par.a, par.xc + par.a, color="k", alpha=0.07)
        ax.text(par.xc, -4.0, "condensate", ha="center", fontsize=9)
        ax.set_xlabel("x [um]")
        ax.set_ylabel(r"$\log_{10}(D_{\mathrm{eff}}/D_{\mathrm{in},0})$")
        ax.set_ylim(-4.2, 0.3)
        ax.set_title(f"({key.upper()}) {key} dose — radial mobility profiles")
        ax.legend(fontsize=8)
    fig.tight_layout()
    _save(fig, "fig_radial_profiles.png")


def figure_dose_response(par, table):
    d = np.array([r["dose"] for r in table])
    Vg = np.array([r["Vgel"] for r in table])
    Vs = np.array([r["Vglass"] for r in table])
    O = np.array([r["O_net"] for r in table])
    TS = np.array([r["TS_active"] for r in table])
    S = np.array([r["Survival"] for r in table])
    fig, axs = plt.subplots(2, 2, figsize=(13.5, 9.5))
    ax = axs[0, 0]
    ax.plot(d, Vg, "s-", color="tab:green", label="gel (percolated) volume")
    ax.plot(d, Vs, "^-", color="tab:purple", label="glass/solid volume")
    ax.set_xlabel("dose $c_{res}$ [c.u.]"); ax.set_ylabel("condensate volume fraction")
    ax.set_title("(A) cured / solidified condensate volume at t = 48 h")
    ax.legend(fontsize=9)
    ax = axs[0, 1]
    cd = np.linspace(0, d.max(), 300)
    ax.plot(cd, np.exp(-(cd/0.72)**2), ":", color="grey", lw=2.2,
            label="pipeline claim: dissolution shuts down oncogene program")
    ax.plot(d, O, "o-", color="tab:red", lw=2.2,
            label="model: oncogenic transcription (net, incl. de-repression)")
    ax.axhline(1.0, color="k", lw=0.7, ls="--")
    ax.set_xlabel("dose $c_{res}$ [c.u.]"); ax.set_ylabel("normalized oncogene output")
    ax.set_title("(B) paradoxical maintenance of oncogenic transcription")
    ax.legend(fontsize=8)
    ax = axs[1, 0]
    ax.plot(d, TS, "o-", color="tab:blue", lw=2)
    ax.set_xlabel("dose $c_{res}$ [c.u.]"); ax.set_ylabel("functional tumor-suppressor activity")
    ax.set_title("(C) p53 / co-activator / proteasome sequestration trap")
    ax = axs[1, 1]
    ax.plot(d, S, "o-", color="tab:orange", lw=2.4)
    ax.axhline(S[0], color="k", ls="--", lw=0.8)
    ax.set_xlabel("dose $c_{res}$ [c.u.]"); ax.set_ylabel("relative cell survival, 48 h")
    ax.set_title("(D) inverted-U drug-tolerance (resistance) curve")
    fig.tight_layout()
    _save(fig, "fig_dose_response.png")


# =============================================================================
#  VI. 主流程
# =============================================================================
def main():
    par = P()
    print("="*78)
    print(" llps_condensate_phase_transition_sim.py")
    print(" Gelation-Trap & epigenetic-resistance adjudication (0-48 h)")
    print("="*78)

    # ---- 第 1 部分: 热力学 / 逾渗 --------------------------------------------
    chi_crit, c_gel = figure_thermo(par)
    theta_c = par.theta_c
    thg = np.linspace(0, 1, 2000)
    td45, _ = theta_for_dissolution(
        lambda t: 1.9*(1 - 0.45*np.asarray(t, float)), chi_crit, thg)
    td90, _ = theta_for_dissolution(
        lambda t: 1.9*(1 - 0.90*np.asarray(t, float)), chi_crit, thg)
    print(f"[thermo] chi_crit (toy, Np=8) ~ {chi_crit:.3f}")
    print(f"[thermo] gel point theta_c = {theta_c:.2f} "
          f"(equiv. arms f_eff ~ {1 + 1/theta_c:.1f})")
    print(f"[thermo] free-drug gel threshold c_gel = {c_gel:.3f} c.u.")
    print(f"[thermo] dissolution occupancy  eta=0.9  -> "
          f"{td90 if td90 is not None else 'unreachable'};   "
          f"eta=0.45 (high-P multivalent) -> "
          f"{td45 if td45 is not None else 'UNREACHABLE'}")
    print("         => gelation/percolation always precedes any melting occupancy;")
    print("         => a high-P multivalent drug never enters a dissolution window.")

    # ---- 第 2 部分: 时空动力学剂量扫掠 -----------------------------------------
    sim = CuringSim(par)
    print("\n[run] dose sweep, 0-48 h ...")
    table = []
    repr_runs = {}
    for dose in par.DOSES:
        res = sim.run(dose)
        st = analyze_run(res, par, dose)
        table.append(st)
        print(f"   dose={dose:5.2f} | Vgel={st['Vgel']:.3f} "
              f"Vglass={st['Vglass']:.3f} Vtrap={st['Vtrap']:.3f} "
              f"O_net={st['O_net']:.3f} TS={st['TS_active']:.3f} "
              f"retention={st['retention']:.3f} Survival={st['Survival']:.3f}")
        for key, dd in [("low", par.DOSE_LOW), ("mid", par.DOSE_MID),
                        ("high", par.DOSE_HIGH)]:
            if abs(dose - dd) < 1e-9 and key not in repr_runs:
                repr_runs[key] = res

    # ---- 图件 ----------------------------------------------------------------
    figure_curing(par, repr_runs)
    figure_state_diagram(par, repr_runs)
    figure_radial(par, repr_runs)
    figure_dose_response(par, table)

    # ---- 数据表 --------------------------------------------------------------
    flds = list(table[0].keys())
    csv_path = os.path.join(OUTDIR, "dose_response.csv")
    with open(csv_path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=flds)
        w.writeheader()
        for r in table:
            w.writerow(r)
    print("\nsaved table:", csv_path)

    # ---- 诊断 JSON -------------------------------------------------------------
    smax = max(table, key=lambda r: r["Survival"])
    mid = [r for r in table if abs(r["dose"] - par.DOSE_MID) < 1e-9][0]
    hi = [r for r in table if abs(r["dose"] - par.DOSE_HIGH) < 1e-9][0]
    claimed_at_mid = float(np.exp(-(par.DOSE_MID/0.72)**2))
    diag = {
        "gel_point_occupancy_theta_c": theta_c,
        "free_drug_gel_threshold_c_gel": round(float(c_gel), 3),
        "dissolution_occupancy_eta0.45": (None if td45 is None else round(float(td45), 3)),
        "dissolution_occupancy_eta0.9": (None if td90 is None else round(float(td90), 3)),
        "condensate_retention_at_mid_dose": round(float(mid["retention"]), 4),
        "glass_volume_at_mid_dose": round(float(mid["Vglass"]), 3),
        "glass_volume_at_high_dose": round(float(hi["Vglass"]), 3),
        "oncogene_output_model_at_mid_dose": round(float(mid["O_net"]), 3),
        "oncogene_output_pipeline_claim_at_mid_dose": round(float(claimed_at_mid), 3),
        "TS_active_at_mid_dose": round(float(mid["TS_active"]), 3),
        "survival_invertedU_peak_dose": round(float(smax["dose"]), 3),
        "survival_invertedU_peak_value": round(float(smax["Survival"]), 3),
        "survival_at_zero_dose": round(float(table[0]["Survival"]), 3),
        "survival_at_max_dose": round(float(table[-1]["Survival"]), 3),
        "note": ("CPD-X 为虚构化合物；本模拟为物理动机明确的唯象 toy model, "
                 "用于论证非平衡凝胶化陷阱的非平凡后果，不构成对任何真实药物的疗效预测。")
    }
    jpath = os.path.join(OUTDIR, "simulation_diagnostics.json")
    with open(jpath, "w") as fh:
        json.dump(diag, fh, indent=2, ensure_ascii=False)
    print("saved json:", jpath)
    print("\n[done] outputs in", OUTDIR)
    for fn in sorted(os.listdir(OUTDIR)):
        if fn.endswith((".png", ".csv", ".json")):
            print("   -", fn)


if __name__ == "__main__":
    main()
