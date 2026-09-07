#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
epigenetic_spreading_lattice_sim.py
===================================
A non-equilibrium, division-coupled lattice model of CpG-methylation epigenetic
spreading after CRISPR-dCas9-DNMT3A/3L targeted de novo methylation.

Motivating claim under adversarial review
-----------------------------------------
"Transient (48 h) expression of dCas9-DNMT3A-DNMT3L targeting one ~250 bp CpG
island establishes a permanent, heritable and *strictly confined* silent state;
methylation never diffuses to neighbouring genes and never perturbs 3D
chromatin topology."

This code implements the counter-model used to test that claim:

* one-dimensional "chromatin epigenetic-state lattice" of N coarse-grained
  bins (≈ nucleosome-sized units) along a chromosome, spanning one CTCF-bounded
  TAD (bins 0-65, "TAD_A") and a neighbouring TAD (bins 66-99, "TAD_B");
* each bin carries  DNA-CpG methylation density x_i and  H3K9me2/3-heterochromatin
  mark density y_i  (both in [0,1]);
* three mutually reinforcing "writers" create a positive-feedback loop
    x --(MBD/SUV39H1/G9a)--> y --(HP1/UHRF1-->DNMT1)--> x ,
  plus a CTCF-insulated short-range processivity kernel (DNMT3A/SUV39H1 act a
  few nucleosomes away) and a full Hi-C-like 3D contact matrix whose dominant
  feature is a promoter-promoter "chromatin-loop collision" between the edited
  island and a distal tumour-suppressor promoter inside the same TAD;
* division (one cell generation) is an explicit operator: methylation survival
  = DNMT1/UHRF1 maintenance efficiency, itself boosted by the H3K9me3 mark
  (mitotic heritability); TET-family active demethylation is a continuous
  eraser competing with the writers in the interphase ODE part.

Two bifurcation-relevant predictions are reproduced:
  1. there is NO robust "stable-but-strictly-confined" window: whenever the
     edited island is heritable it invades its TAD (bistable reaction front),
     and its 3D loop partner is colonized first ("jumping" erosion);
  2. whether the mark collapses back to unmethylated or propagates across the
     CTCF boundary and silences a whole neighbouring TAD depends on
     (TET erasure, DNMT1/UHRF1 feedback strength, CTCF insulation) - mapped in
     the delivered figures.

Figures delivered
-----------------
  fig1_methylation_heatmap.png  nucleosome bin x cell-division heatmaps for 3
                                canonical outcomes (revert / intra-TAD spread
                                + loop-partner loss / trans-boundary silencing)
  fig2_regime_phase_diagram.png outcome phase diagram in (TET-erasure gamma,
                                DNMT1/UHRF1 feedback gain eta) and
                                (gamma, CTCF insulation beta) + seed-size
                                bistability (critical-nucleus) curves
  fig3_spreading_timing.png     timing of the loop "jump" vs linear reaction-
                                diffusion front, and CTCF-breach time vs beta

Usage
-----
  python epigenetic_spreading_lattice_sim.py [--outdir DIR] [--T 70] [--noise 0]
        [--fast] [--figs 1,2,3]
Run with no options to regenerate every figure and print the parameter summary.
Scenario parameters (gamma_TET, feedback gain eta, CTCF insulation beta) are
encoded in the canonical scenario table at the bottom of this module; edit the
`scen`/`panel` dictionaries or import the functions to explore other regimes.

Model equations (dimensionless, time unit = one cell division/generation)
--------------------------------------------------------------------------
field_i  = w_self x_i + w_nn (processivity)_i + w_3d (row-norm 3D contact)_i
dx_i/dt = k_m * Hill(field_i + w_his eta y_i ; thx) * (1-x_i) - gamma * x_i
dy_i/dt = ( Hill(field_i ; thy) - y_i ) / tau_y
division:  x_i <- x_i * { m_lo + (m_hi - m_lo) Hill(y_i; m_thr) }
Each lattice unit = coarse-grained bin; all rates per generation. See companion
review report for parameter table, regime map and clinical-design implications.
"""

import argparse
import os
import numpy as np

# ============================================================================
# Lattice geometry (coarse-grained bins along one chromosome)
# ============================================================================
N = 100
ISLAND = slice(46, 55)   # oncogene-promoter CpG island == gRNA-target "250 bp window"
TSG    = slice(14, 22)   # distal tumour-suppressor promoter, loop-anchored to ISLAND
CTC    = 66              # CTCF/cohesin boundary between TAD_A (bins 0..65) and TAD_B (66..99)
HOUSING= slice(80, 89)   # essential (housekeeping) promoter inside TAD_B
GK     = np.array([1.0, 0.6, 0.35, 0.2])  # writer processivity kernel (k = 1..3 bins)
_GK    = GK / GK.sum()

# Region colours shared by every figure (colour-threading)
COL = dict(island='#E66101', tsg='#7B3294', housing='#1B9E77', ctc='#333333')

def hill(u, thr, n=4):
    """Hill (sigmoidal) activation, steepness n."""
    u = np.clip(u, 0.0, None)
    return u ** n / (u ** n + thr ** n)


# ============================================================================
# Model parameters & linear operators
# ============================================================================
def default_params(gamma=0.3, gain=1.0, beta=0.82, thx=0.66, k_m=2.2):
    """
    gamma : TET-family active-demethylation rate  [gen^-1]
    gain  : eta, dimensionless DNMT1/UHRF1-H3K9 feedback gain (multiplies the
            H3K9->DNMT1 reinforcement and the H3K9-boosted maintenance ceiling)
    beta  : CTCF insulation 0..1 (fraction of boundary-crossing writer/contact
            flux blocked)
    """
    return dict(N=N, w_self=0.25, w_nn=0.35, w_3d=0.40, w_his0=0.50,
                thx=thx, thy=0.34, k_m=k_m, tau_y=3.0,
                gamma=gamma, gain=gain, beta=beta,
                m_lo=0.72, m_hi_max=0.985, m_thr=0.28, dt=0.05,
                loop=6.0, lam=8.0, ctc=CTC)


def linear_operator(P):
    """
    Pre-composed linear influence operator A (N x N), A_ij = weight with which
    methylation at bin j drives bin i through all *linear* channels:
        A = w_self I + w_nn L + w_3d W
    L  : short-range processivity operator (DNMT3A/SUV39H1 spread a few bins),
         scaled by (1-beta) across the CTCF boundary (insulator leakage).
    W  : row-normalised Hi-C-like 3D contact matrix (distance-decaying contact
         + dominant promoter-promoter loop between ISLAND and TSG), also
         boundary-insulated.
    The returned A makes the interphase field  field_i = (A x)_i.
    """
    n, ctc, s = P['N'], P['ctc'], 1.0 - P['beta']
    # -- processivity matrix L ------------------------------------------------
    L = np.zeros((n, n))
    for k, g in enumerate(_GK, start=1):
        for off in (-k, k):
            src = np.arange(n); dst = src + off
            ok = (dst >= 0) & (dst < n)
            crossing = (np.minimum(src, dst) < ctc) & (np.maximum(src, dst) >= ctc)
            scale = np.where(crossing, s, 1.0)
            L[dst[ok], src[ok]] += g * scale[ok]
    # -- Hi-C-like 3D contact matrix (row normalised) --------------------------
    i = np.arange(n); d = np.abs(i[:, None] - i[None, :])
    J = np.exp(-d / P['lam'])
    cross = (np.minimum(i[:, None], i[None, :]) < ctc) & (np.maximum(i[:, None], i[None, :]) >= ctc)
    J[cross] *= s
    loop = P['loop']
    for a in range(ISLAND.start, ISLAND.stop):
        for b in range(TSG.start, TSG.stop):
            J[a, b] = J[b, a] = loop
    np.fill_diagonal(J, 0.0)
    W = J / (J.sum(axis=1, keepdims=True) + 1e-12)
    return P['w_self'] * np.eye(n) + P['w_nn'] * L + P['w_3d'] * W


def init_state(P, mode='island', x0=0.95, center=None, width=None):
    x = np.zeros(P['N']); y = np.zeros(P['N'])
    if mode == 'island':
        x[ISLAND] = x0
    elif mode == 'full':
        x[:] = x0
    elif mode == 'window':                       # arbitrary seed block (critical-nucleus runs)
        x[center:center + width] = x0
    return x, y


# ============================================================================
# Single-trajectory simulator (deterministic ODE + division operator)
# ============================================================================
def run_sim(P, T=70, mode='island', x0=0.95):
    """Return X, Y arrays of shape (T+1, N): methylation and H3K9me3 density."""
    A = linear_operator(P); At = A.T
    x, y = init_state(P, mode, x0)
    nsub = int(round(1.0 / P['dt']))
    wHis = P['w_his0'] * P['gain']
    m_hi = P['m_lo'] + (P['m_hi_max'] - P['m_lo']) * min(P['gain'], 1.0)
    X = np.empty((T + 1, P['N'])); Y = np.empty((T + 1, P['N']))
    X[0] = x; Y[0] = y
    for g in range(T):
        for _ in range(nsub):
            f = x @ At
            prod = P['k_m'] * hill(f + wHis * y, P['thx'])
            dx = prod * (1.0 - x) - P['gamma'] * x
            dy = (hill(f, P['thy']) - y) / P['tau_y']
            x = np.clip(x + P['dt'] * dx, 0.0, 1.0)
            y = np.clip(y + P['dt'] * dy, 0.0, 1.0)
        surv = P['m_lo'] + (m_hi - P['m_lo']) * hill(y, P['m_thr'], n=2)
        x = x * surv
        X[g + 1] = x; Y[g + 1] = y
    return X, Y


def simulate_grid(P0, gammas, gains, A, T=90, mode='island', x0=0.95,
                  center=None, width=None):
    """
    Vectorised batch: N_grid independent trajectories that share A (same
    insulation beta / loop structure) but differ in (gamma, gain). Returns
    final methylation matrix of shape (len(gammas), N).
    """
    gammas = np.asarray(gammas, float); gains = np.asarray(gains, float)
    gv = gammas[:, None]; gn = gains[:, None]; G = len(gammas)
    wHis = P0['w_his0'] * gn
    m_hi = P0['m_lo'] + (P0['m_hi_max'] - P0['m_lo']) * np.minimum(gn, 1.0)
    n = P0['N']; nsub = int(round(1.0 / P0['dt'])); At = A.T
    x = np.zeros((G, n)); y = np.zeros((G, n))
    if mode == 'island':
        x[:, ISLAND] = x0
    elif mode == 'full':
        x[:] = x0
    elif mode == 'window':
        x[:, center:center + width] = x0
    k_m = P0['k_m']; thx = P0['thx']; thy = P0['thy']
    tau = P0['tau_y']; dt = P0['dt']; mlo = P0['m_lo']; mthr = P0['m_thr']
    for _ in range(T):
        for __ in range(nsub):
            f = x @ At
            prod = k_m * hill(f + wHis * y, thx)
            dx = prod * (1.0 - x) - gv * x
            dy = (hill(f, thy) - y) / tau
            x = np.clip(x + dt * dx, 0.0, 1.0)
            y = np.clip(y + dt * dy, 0.0, 1.0)
        surv = mlo + (m_hi - mlo) * hill(y, mthr, n=2)
        x = x * surv
    return x


# ============================================================================
# Region summaries / timing diagnostics
# ============================================================================
def region_mean_t(X, region):
    if region == 'island': sl = ISLAND
    elif region == 'tsg': sl = TSG
    elif region == 'housing': sl = HOUSING
    elif region == 'tadA': sl = slice(0, CTC)
    elif region == 'tadB': sl = slice(CTC, N)
    else:
        mask = np.ones(N, bool); mask[ISLAND] = False; mask[TSG] = False
        mask[CTC:] = False; sl = mask
    return X[:, sl].mean(axis=1)


def first_time(X, region, th=0.5):
    """First generation (>=1) at which methylation density exceeds `th`
    anywhere inside `region` (inf if never)."""
    if region == 'all': sl = slice(0, N)
    elif region == 'island': sl = ISLAND
    elif region == 'tsg': sl = TSG
    elif region == 'tadB': sl = slice(CTC, N)
    elif region == 'tadA': sl = slice(0, CTC)
    sub = X[1:, sl]
    hit = sub > th
    if not hit.any():
        return np.inf
    return int(np.argmax(hit.any(axis=1)) + 1)


def scenario_table(T=70):
    """Run the three canonical scenarios and print a summary table."""
    scen = {
        'collapse (editing reverts)':   dict(gamma=0.65, gain=0.50, beta=0.82, label='collapse'),
        'intra-TAD wave + loop loss':   dict(gamma=0.30, gain=1.00, beta=0.82, label='insulate'),
        'trans-boundary silencing':     dict(gamma=0.30, gain=1.00, beta=0.60, label='breach'),
    }
    rows = []
    for key, ov in scen.items():
        P = default_params(gamma=ov['gamma'], gain=ov['gain'], beta=ov['beta'])
        X, Y = run_sim(P, T=T)
        rows.append((key, ov['label'], P, X, Y))
    print('\n=== canonical scenario summary (T = %d generations) ===' % T)
    hdr = f"{'scenario':34s} {'end isl':>7s} {'end tsg':>7s} {'end TAD_A':>9s} {'end TAD_B':>9s} {'t_tsg':>6s} {'t_TADB':>7s}"
    print(hdr)
    for key, lab, P, X, Y in rows:
        t_tsg = first_time(X, 'tsg'); t_B = first_time(X, 'tadB')
        print(f"{key:34s} {X[-1, ISLAND].mean():7.2f} {X[-1, TSG].mean():7.2f} "
              f"{X[-1, :CTC].mean():9.2f} {X[-1, CTC:].mean():9.2f} "
              f"{t_tsg:6.0f} {('inf' if np.isinf(t_B) else str(t_B)):>7s}")
    return rows


# ============================================================================
# Chinese-capable matplotlib styling
# ============================================================================
def setup_style():
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.font_manager as fm
    cands = ['PingFang SC', 'Heiti SC', 'Heiti TC', 'Songti SC', 'Arial Unicode MS',
             'Hiragino Sans GB', 'Noto Sans CJK SC', 'SimHei', 'Microsoft YaHei']
    avail = {f.name for f in fm.fontManager.ttflist}
    chosen = next((c for c in cands if c in avail), None)
    if chosen:
        plt.rcParams['font.family'] = 'sans-serif'
        plt.rcParams['font.sans-serif'] = [chosen, 'DejaVu Sans']
    plt.rcParams['axes.unicode_minus'] = False
    plt.rcParams['savefig.bbox'] = 'tight'
    return plt


def _region_bands(ax, alpha=0.10):
    """Faint horizontal gene bands behind a heatmap (same colours everywhere)."""
    for sl, name, c in [(ISLAND, 'island', COL['island']), (TSG, 'tsg', COL['tsg']),
                        (HOUSING, 'housing', COL['housing'])]:
        ax.axhspan(sl.start, sl.stop, color=c, alpha=alpha, zorder=0, lw=0)
    ax.axhline(CTC, color=COL['ctc'], lw=1.4, ls=(0, (4, 2)), zorder=0)
    ax.set_ylim(-0.5, N - 0.5)


def _region_legend(ax):
    from matplotlib.patches import Patch
    from matplotlib.lines import Line2D
    handles = [Patch(color=COL['island'], label='癌基因启动子 CpG 岛 (gRNA 靶窗)'),
               Patch(color=COL['tsg'],   label='远端抑癌基因启动子 (3D 环伙伴, 同 TAD)'),
               Patch(color=COL['housing'], label='管家基因启动子 (相邻 TAD_B)'),
               Line2D([0], [0], color=COL['ctc'], ls=(0, (4, 2)), label='CTCF 边界 (bin 66)')]
    ax.legend(handles=handles, loc='upper center', bbox_to_anchor=(0.5, -0.06),
              ncol=2, frameon=False, fontsize=8)


# ============================================================================
# Figure 1 - methylation-density heatmaps across cell divisions
# ============================================================================
def figure1_heatmap(rows, outpath, T=60, dpi=200):
    plt = setup_style()
    fig, axes = plt.subplots(3, 1, figsize=(10.2, 9.6), sharex=True)
    panel_titles = [
        ('A', '结局 I · 编辑回退 (TET 去甲基化 + 维持失败主导): ~10 代内崩解回未甲基化状态',
         'γ_TET=0.65  维持增益 η=0.50  绝缘 β=0.82'),
        ('B', '结局 II · 波前扩散 + 远端环伙伴“跳跃式”失守 (CTCF 强绝缘, 但同 TAD 内已全沉默)',
         'γ_TET=0.30  维持增益 η=1.00  绝缘 β=0.82'),
        ('C', '结局 III · 延迟跨边界全 TAD_B 沉默 (CTCF 渗漏)',
         'γ_TET=0.30  维持增益 η=1.00  绝缘 β=0.60'),
    ]
    for ax, (X, Y, P), (tag, title, sub) in zip(axes, rows, panel_titles):
        ax.imshow(X[:T + 1].T, origin='lower', aspect='auto', cmap='viridis',
                  vmin=0.0, vmax=1.0, extent=[0, T, -0.5, N - 0.5], interpolation='nearest')
        _region_bands(ax)
        ax.text(0.985, 0.03, f'{tag}.  {title}\n{sub}   |   初始脉冲 x=0.95 (bin 46–55, 第 0 代撤除 dCas9)',
                transform=ax.transAxes, ha='right', va='bottom', fontsize=8,
                bbox=dict(fc='white', ec='0.6', alpha=0.85, boxstyle='round,pad=0.3'))
        ax.set_ylabel('染色质晶格位点 (bin, 5′→3′)', fontsize=9)
        ax.set_yticks(np.arange(0, N + 1, 20))
    axes[2].set_xlabel('细胞分裂代数 / 世代 (generation after dCas9 withdrawal)', fontsize=10)
    for ax in axes:
        ax.tick_params(labelsize=8)
    fig.subplots_adjust(right=0.86, hspace=0.32)
    cbar_ax = fig.add_axes([0.875, 0.13, 0.022, 0.74])
    from matplotlib import cm as _cm
    sm = _cm.ScalarMappable(cmap='viridis', norm=plt.Normalize(0, 1))
    sm.set_array([])
    cb = fig.colorbar(sm, cax=cbar_ax)
    cb.set_label('CpG 甲基化密度 x (0–1)', fontsize=9)
    cb.ax.tick_params(labelsize=8)
    _region_legend(fig.axes[0])
    fig.savefig(outpath, dpi=dpi)
    plt.close(fig)
    print('wrote', outpath)


# ============================================================================
# Figure 2 - regime phase diagrams and bistability (critical-nucleus) curves
# ============================================================================
def _zone_texts(D, xv, yv):
    """Auto-place regime labels. D is the *displayed* matrix with rows along yv
    and columns along xv; returns (text, x, y) at the centroid of each zone."""
    labs = []
    for lo, hi, txt in [(-np.inf, 0.12, '回退 (不可持久)'),
                        (0.12, 0.42, None),                 # narrow transition, unlabeled
                        (0.42, 0.70, 'TAD_A 内扩散沉默\n(环伙伴同步失守)'),
                        (0.70, np.inf, '跨 TAD / 全晶格沉默')]:
        m = (D >= lo) & (D < hi)
        rr, cc = np.where(m)
        if len(rr) < 4 or txt is None:
            continue
        labs.append((txt, float(np.median(xv[cc])), float(np.median(yv[rr]))))
    return labs


def figure2_phase(outpath, dpi=200, coarse=False, keep=False):
    plt = setup_style()
    base = default_params()
    nx = 34 if coarse else 46; ny = 24 if coarse else 34
    Tgrid = 70 if coarse else 100
    gammas = np.linspace(0.02, 2.6, nx)
    gains = np.linspace(0.35, 1.5, ny)

    # ---- Panel A: outcome map over (gamma_TET x feedback gain eta), beta=0.60
    P = default_params(beta=0.60)
    A = linear_operator(P)
    gg, gn = np.meshgrid(gammas, gains, indexing='ij')
    xf = simulate_grid(P, gg.ravel(), gn.ravel(), A, T=Tgrid)
    M_A = xf.mean(axis=1).reshape(nx, ny)          # whole-lattice final methylation

    # ---- Panel B: outcome map over (gamma_TET x CTCF insulation beta), gain=1
    nb = 22 if coarse else 30
    betas = np.linspace(0.02, 0.96, nb)
    M_B = np.empty((nx, nb))
    for j, b in enumerate(betas):
        Pb = default_params(beta=b)
        Ab = linear_operator(Pb)
        xb = simulate_grid(Pb, gammas, np.full(nx, 1.0), Ab, T=Tgrid)
        M_B[:, j] = xb.mean(axis=1)

    fig = plt.figure(figsize=(13.5, 4.6))
    gs = fig.add_gridspec(1, 3, width_ratios=[1.15, 1.15, 1.0], wspace=0.42,
                          left=0.075, right=0.98, top=0.80, bottom=0.13)

    # Panel A
    ax = fig.add_subplot(gs[0])
    imA = ax.imshow(M_A.T, origin='lower', aspect='auto', cmap='magma', vmin=0, vmax=0.9,
                    extent=[gammas[0], gammas[-1], gains[0], gains[-1]])
    ax.contour(gammas, gains, M_A.T, levels=[0.12, 0.42, 0.70], colors=['0.25'], linewidths=0.8)
    for txt, gx, gy in _zone_texts(M_A.T, gammas, gains):
        ax.text(gx, gy, txt, ha='center', va='center', fontsize=8,
                bbox=dict(fc='white', ec='none', alpha=0.72, pad=0.5))
    ax.set_xlabel('TET 主动去甲基化强度  γ_TET (代^-1)')
    ax.set_ylabel('维持正反馈增益  η (DNMT1/UHRF1-H3K9)')
    ax.set_title('A. 结局相图 (绝缘 β=0.60)', fontsize=10)
    ax.text(0.03, 0.97, '终态晶格甲基化', transform=ax.transAxes, fontsize=8, va='top',
            bbox=dict(fc='white', alpha=0.7, pad=0.2))
    fig.colorbar(imA, ax=ax, shrink=0.85, label='终态全晶格甲基化均值 (0–1)')

    # Panel B
    ax2 = fig.add_subplot(gs[1])
    imB = ax2.imshow(M_B.T, origin='lower', aspect='auto', cmap='magma', vmin=0, vmax=0.9,
                     extent=[gammas[0], gammas[-1], betas[0], betas[-1]])
    ax2.contour(gammas, betas, M_B.T, levels=[0.12, 0.70], colors=['0.25'], linewidths=0.8)
    for txt, gx, gy in _zone_texts(M_B.T, gammas, betas):
        ax2.text(gx, gy, txt, ha='center', va='center', fontsize=8,
                 bbox=dict(fc='white', ec='none', alpha=0.72, pad=0.5))
    ax2.set_xlabel('TET 主动去甲基化强度  γ_TET (代^-1)')
    ax2.set_ylabel('CTCF 绝缘强度 β (0=无, 1=完全)')
    ax2.set_title('B. 结局相图 (维持增益 η=1.0)', fontsize=10)
    fig.colorbar(imB, ax=ax2, shrink=0.85, label='终态全晶格甲基化均值 (0–1)')

    # Panel C - critical-nucleus (bistability) curves
    ax3 = fig.add_subplot(gs[2])
    Pc = default_params(beta=0.82)
    Ac = linear_operator(Pc)
    widths = np.arange(1, 13)
    gline = [0.30, 0.55, 0.80, 1.05]
    # (width must vary -> one small vectorised run per width per gamma)
    cols = ['#1f77b4', '#2ca02c', '#ff7f0e', '#d62728']
    for gi, gm in enumerate(gline):
        final = np.empty(len(widths))
        for wi, w in enumerate(widths):
            Xw = simulate_grid(Pc, [gm], [1.0], Ac, T=Tgrid, mode='window',
                               center=N // 2, width=w, x0=0.95)
            final[wi] = Xw[0].mean()
        ax3.plot(widths, final, 'o-', color=cols[gi], ms=4, lw=1.6,
                 label=f'γ_TET = {gm:.2f}')
        wc = np.argmax(final > 0.4) if np.any(final > 0.4) else None
        if wc is not None:
            ax3.axvline(widths[wc], color=cols[gi], lw=0.8, ls=':', alpha=0.8)
            ax3.text(widths[wc], 0.05 + 0.02 * (gi % 2), f'w_c={widths[wc]}', rotation=90,
                     fontsize=7, color=cols[gi], va='bottom', ha='right')
    ax3.set_xlabel('初始脉冲宽度 w (被编辑核小体/bins)')
    ax3.set_ylabel('终态全晶格甲基化均值 (0–1)')
    ax3.set_title('C. 双稳性 · 临界核 w$_c$(γ)', fontsize=10)
    ax3.set_ylim(-0.03, 1.0); ax3.set_xlim(0.5, 12.5)
    ax3.legend(fontsize=7, frameon=False, title='生成后维持竞争环境', title_fontsize=7)
    ax3.text(0.03, 0.97, '同一 (γ,η) 下: 大脉冲->持久扩散; 亚临界脉冲->塌陷 => 双稳态/迟滞',
             transform=ax3.transAxes, fontsize=6.5, va='top',
             bbox=dict(fc='white', alpha=0.75, pad=0.3))
    fig.savefig(outpath, dpi=dpi)
    print('wrote', outpath)
    if keep:
        return M_A, M_B, gammas, gains, betas, fig
    plt.close(fig)
    return M_A, M_B, gammas, gains, betas


# ============================================================================
# Figure 3 - spreading timing (loop jump & boundary breach)
# ============================================================================
def figure3_timing(outpath, dpi=200, T=200):
    plt = setup_style()
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12.5, 4.2))
    # --- Panel A: 3D loop jump vs linear reaction-diffusion arrival ----------
    P = default_params(gamma=0.30, gain=1.0, beta=0.60)
    Xl, _ = run_sim(P, T=70)
    Pl = dict(P); Pl['loop'] = 0.0                       # ablate the loop
    Xn, _ = run_sim(Pl, T=70)
    tl = region_mean_t(Xl, 'tsg'); tn = region_mean_t(Xn, 'tsg')
    gs = np.arange(0, 71)
    ax1.plot(gs, tl, color=COL['tsg'], lw=2.0, label='远端 TSG 启动子 (有 3D 环, 跳跃侵蚀)')
    ax1.plot(gs, tn, color=COL['tsg'], lw=2.0, ls='--', alpha=0.75,
             label='远端 TSG 启动子 (无 3D 环: 仅线性反应扩散波前)')
    ax1.plot(gs, region_mean_t(Xl, 'island'), color=COL['island'], lw=1.6, alpha=0.9,
             label='被编辑 CpG 岛 (维持平台)')
    ax1.axvline(np.argmax(tl > 0.5), color=COL['tsg'], ls=':', lw=1)
    ax1.axvline(np.argmax(tn > 0.5), color=COL['tsg'], ls='--', lw=1)
    ax1.set_xlabel('细胞分裂代数 (generation)')
    ax1.set_ylabel('区域平均 CpG 甲基化密度 (0–1)')
    ax1.set_title('A. 3D 环“跳跃”远早于线性波前到达', fontsize=10)
    ax1.legend(fontsize=7.5, frameon=False, loc='center right')
    ax1.text(0.03, 0.06,
             f'跳跃殖民 ≈ 第 {np.argmax(tl>0.5)} 代 (线性波前需 ≈ 第 {np.argmax(tn>0.5)} 代)',
             transform=ax1.transAxes, fontsize=8, bbox=dict(fc='white', alpha=0.85, pad=0.3))

    # --- Panel B: CTCF breach time vs insulation beta -------------------------
    betas = np.linspace(0.0, 0.97, 40)
    tB = []
    for b in betas:
        Pb = default_params(gamma=0.30, gain=1.0, beta=b)
        Xb, _ = run_sim(Pb, T=T)
        tB.append(first_time(Xb, 'tadB', th=0.5))
    tB = np.array(tB, float)
    fin = np.isfinite(tB)
    ax2.plot(betas[fin], tB[fin], 'o-', color='#111111', ms=3.5, lw=1.6,
             label='TAD_B 首个位点被殖民时间')
    if (~fin).any():
        bfirst_inf = betas[~fin].min()
        ax2.axvline(bfirst_inf, color='#8c510a', ls='--', lw=1.4)
        ax2.text(bfirst_inf + 0.01, 0.25 * T, f'β* ≈ {bfirst_inf:.2f}\n(大于此值: 200 代内不可渗透)',
                 fontsize=8, color='#8c510a')
    ax2.set_xlabel('CTCF 绝缘强度 β (0=无绝缘, 1=完全绝缘)')
    ax2.set_ylabel('首次突破边界进入 TAD_B 的代际时间')
    ax2.set_title('B. 边界渗漏时序: 需要多强的绝缘才能封住波前?', fontsize=10)
    ax2.set_ylim(0, T * 1.02)
    ax2.legend(fontsize=8, frameon=False)
    fig.tight_layout()
    fig.savefig(outpath, dpi=dpi)
    plt.close(fig)
    print('wrote', outpath)


# ============================================================================
# CLI
# ============================================================================
def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--outdir', default='.', help='output directory')
    ap.add_argument('--figs', default='1,2,3', help='comma list of figures to draw (1,2,3)')
    ap.add_argument('--T', type=int, default=70, help='generations for scenario trajectories')
    ap.add_argument('--fast', action='store_true', help='coarser phase grids (for quick runs)')
    ap.add_argument('--noise', type=float, default=0.0, help='division noise sigma (0 = deterministic)')
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)
    tag = lambda f: os.path.join(args.outdir, f)

    rows = scenario_table(T=args.T)
    sel = set(args.figs.split(','))
    if '1' in sel:
        # regenerate the canonical trajectories used for the heatmaps
        heat_rows = []
        for key, lab, P, X, Y in rows:
            if lab in ('collapse', 'insulate', 'breach'):
                heat_rows.append((X, Y, P))
        figure1_heatmap(heat_rows, tag('fig1_methylation_heatmap.png'), T=60)
    if '2' in sel:
        figure2_phase(tag('fig2_regime_phase_diagram.png'), coarse=args.fast)
    if '3' in sel:
        figure3_timing(tag('fig3_spreading_timing.png'))
    print('\nAll requested outputs written under:', os.path.abspath(args.outdir))


if __name__ == '__main__':
    main()
