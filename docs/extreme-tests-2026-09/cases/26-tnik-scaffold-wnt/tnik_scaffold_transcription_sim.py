#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tnik_scaffold_transcription_sim.py
==================================
Systems-pharmacology rebuttal model: the "catalytic vs scaffold disconnect"
paradox of ultra-potent ATP-competitive TNIK inhibitors acting in nuclear,
phase-separated Wnt transcription hubs.

Motivating (adversarial) claim under review
--------------------------------------------
"An IC50 = 0.5 nM ATP-pocket TNIK inhibitor will, by locking the kinase in an
inactive conformation, simultaneously dissolve the physical TNIK-TCF4/beta-
catenin scaffold, dismantle nuclear transcription condensates in CRC stem cells
and achieve a 100 % gene-level Wnt shutdown with no compensatory signalling."

What this script quantifies
---------------------------
1) A reaction-transport ODE model of the drug's journey into the hub:
     extracellular dose (bath) -> cytosol (membrane) -> dilute nucleoplasm
     (nuclear pore) -> LLPS dense hub (partition coefficient kappa), where it
     competes with millimolar ATP for the TNIK catalytic site (Cheng-Prusoff)
     and must silence essentially all hub-resident TNIK before the steep,
     multi-site transcriptional licensing gate responds.  Outputs the
     dose-response of (i) catalytic occupancy/activity, (ii) phospho-TCF4 and
     (iii) the TopFlash/TCF reporter - and shows their right-shift separation.
2) A coarse allosteric free-energy dissipation model along the full-length
     TNIK architecture (kinase domain 25-289 -> disordered/low-complexity
     connector 290-1046 -> CNH 1047-1334), showing that coupling free energy
     from an ATP-pocket perturbation decays essentially to zero before it
     reaches the distal beta-catenin / CNH scaffold interfaces.

Domain numbers are from UniProt Q9UKE5 (human TNIK).  Interaction mapping and
the "potent-in-vitro / weak-in-cell" precedent (NCB-0846: 21 nM enzyme IC50 but
micromolar cellular Wnt output) are anchored in the review report that
accompanies this script.

Run:  python tnik_scaffold_transcription_sim.py
Outputs: fig1_tnik_dose_response_decoupling.png
         fig2_tnik_allosteric_dissipation.png
plus a printed metrics block used by the report.
"""

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import colormaps
from matplotlib.patches import Rectangle
from scipy.integrate import solve_ivp

# ==============================================================
# 0.  Constants & full-length TNIK topology (UniProt Q9UKE5)
# ==============================================================
RT_KCAL = 0.001987 * 310.0          # ~0.616 kcal/mol at 37 C

SEQ_LEN  = 1360
KD_RANGE = (25, 289)                # protein kinase domain
ATP_LYS  = 54                       # ATP-binding (catalytic) Lys
CAT_ASP  = 153                      # catalytic proton-acceptor Asp
LINKER_RANGE = (290, 1046)          # connector; NEDD4 site; beta-cat binding
CNH_RANGE = (1047, 1334)            # citron-homology domain
DISORDER_RANGES = [(284, 347), (398, 440), (539, 589), (601, 801),
                   (814, 878), (908, 927), (933, 998)]
BCAT_BIND_RANGE = (290, 1017)       # intermediate domain binding beta-cat (2009 mapping)

# ==============================================================
# 1.  Equilibrium (biochemical) anchors
# ==============================================================
# ki0        - true Ki of the '0.5 nM' inhibitor
# Km_atp     - TNIK ATP Km (typical kinase 10-100 uM)
# IC50 measured in vitro at [ATP]=Km  =>  IC50 = 2*Ki = 0.5 nM  =>  Ki = 0.25 nM
KI0_NM   = 0.25
KM_ATP   = 40.0                     # uM
ATP_CELL = 3000.0                   # uM (3 mM)
A_ATP    = 1.0 + ATP_CELL / KM_ATP  # Cheng-Prusoff multiplier  (= 76)

KD_APP_UM = KI0_NM * 1e-3 * A_ATP             # apparent Kd in the hub (~19 nM)
IC50_INVITRO_UM = 2.0 * KI0_NM * 1e-3         # 0.5 nM  (at [ATP] = Km)
IC50_ATPONLY_UM = 2.0 * KD_APP_UM             # ~38 nM  (ATP competition only)

# ==============================================================
# 2.  Parameters of the intranuclear reaction-transport ODE model
# ==============================================================
P = dict(
    kappa         = 0.10,      # net free-drug partition dense/dilute (<=1 => dilution)
    kappa_range   = [0.03, 0.10, 0.30, 1.00],
    k_perm        = 1.0 / 60.0,     # plasma membrane equilibration, 1/s
    k_pore        = 1.0 / 45.0,     # NPC passive small-molecule diffusion, 1/s
    q_hub         = 1.0 / 600.0,    # dense-phase diffusive exchange (viscous), 1/s
    t_hub_um      = 3.0,            # total hub TNIK catalytic sites (uM, condensed)
    koff          = 2.0e-3,         # 1/s  (t1/2 ~ 6 min)
    kd_app_um     = KD_APP_UM,      # effective Kd seen by hub enzyme (ATP incl.)
    r_deph        = 0.05,           # k_deph/k_phos -> basal phospho = 1/(1+r)
    k_phos        = 1.0e-3,         # 1/s
    tcf_floor     = 0.25,           # TNIK-catalysis-INDEPENDENT fraction of TopFlash
    lic_power     = 4,              # cooperative / multi-site licensing
    lic_p_half    = 0.35,           # phospho fraction at half-maximal licensing
    t_end_s       = 48.0 * 3600.0,  # integration horizon
    doses_um      = np.logspace(-3.0, 2.3, 57),   # 1 nM .. ~200 uM
)

def params_kappa(kappa):
    q = dict(P)
    q['kappa'] = kappa
    return q

# ==============================================================
# 3.  ODE right-hand side (reaction + transport)
# ==============================================================
# y = [c_cyto, c_nuc, c_hub, TI, Sp]
#   c_cyto/c_nuc/c_hub : free drug in cytosol / dilute nucleoplasm / dense hub (uM)
#   TI                 : drug-occupied TNIK in hub (uM, hub-volume basis)
#   Sp                 : phospho-TCF4 in hub (dimensionless fraction)
def make_rhs(dose_um, p):
    kappa = p['kappa']
    kd    = p['kd_app_um']
    kon   = p['koff'] / kd
    ttot  = p['t_hub_um']
    k_ph  = p['k_phos']
    k_dp  = k_ph * p['r_deph']
    k_hi  = kappa * p['q_hub']     # equilibrium c_hub = (k_hi/k_ho) * c_nuc
    k_ho  = p['q_hub']
    perm  = p['k_perm']
    pore  = p['k_pore']

    def rhs(t, y):
        c_c, c_n, c_h, TI, Sp = y
        Ta = max(ttot - TI, 0.0)
        dcc =  perm * (dose_um - c_c) - pore * (c_c - c_n)
        dcn =  pore * (c_c - c_n) - (k_hi * c_n - k_ho * c_h)
        dch =  (k_hi * c_n - k_ho * c_h) - kon * c_h * Ta + p['koff'] * TI
        dTI =  kon * c_h * Ta - p['koff'] * TI
        Sp_ = min(max(Sp, 0.0), 1.0)
        dSp = k_ph * (Ta / ttot) * (1.0 - Sp_) - k_dp * Sp_
        return [dcc, dcn, dch, dTI, dSp]
    return rhs

def simulate_dose_response(p, doses=None):
    """Integrate the ODE to quasi-steady state for each dose; return readouts."""
    if doses is None:
        doses = p['doses_um']
    y0 = [0.0, 0.0, 0.0, 0.0, 1.0 / (1.0 + p['r_deph'])]
    rows = []
    for D in doses:
        sol = solve_ivp(make_rhs(D, p), [0.0, p['t_end_s']], y0,
                        method='LSODA', rtol=1e-6, atol=1e-10, max_step=1800.0)
        c_c, c_n, c_h, TI, Sp = sol.y[:, -1]
        a    = max(1.0 - TI / p['t_hub_um'], 0.0)     # active TNIK fraction (hub)
        pfr  = min(max(Sp, 0.0), 1.0)                 # phospho-TCF4 fraction
        g    = pfr ** p['lic_power'] / (pfr ** p['lic_power']
                                        + p['lic_p_half'] ** p['lic_power'])
        g0   = (1.0 / (1.0 + p['r_deph'])) ** p['lic_power']
        g0   = g0 / (g0 + p['lic_p_half'] ** p['lic_power'])     # basal (no drug)
        top  = p['tcf_floor'] + (1.0 - p['tcf_floor']) * (g / g0)
        rows.append(dict(dose=D, c_cyto=c_c, c_nuc=c_n, c_hub=c_h,
                         active=a, phospho=pfr,
                         topflash=min(max(top, 0.0), 1.0)))
    return rows

def ec50_log(doses, vals):
    """EC50 (uM): log-linear interpolation at half of the descending span."""
    v0, v1 = vals[0], vals[-1]
    tgt = 0.5 * (v0 + v1)
    idx = None
    for i, v in enumerate(vals):
        if v <= tgt:
            idx = i
            break
    if idx is None or idx == 0:
        return float('nan')
    ld = np.log10(doses)
    xA, xB = ld[idx - 1], ld[idx]
    yA, yB = vals[idx - 1], vals[idx]
    x = xA + (tgt - yA) * (xB - xA) / (yB - yA) if yB != yA else xB
    return 10.0 ** x

# ==============================================================
# 4.  Allosteric dissipation model (coarse elastic-chain)
# ==============================================================
def disorder_mask():
    m = np.zeros(SEQ_LEN, dtype=float)
    for (a, b) in DISORDER_RANGES:
        m[a - 1:b] = 1.0
    return m

def coupling_profile(dg0=2.0, lambda_flex=10.0, lambda_kd=800.0, q_kd=0.5):
    """Free energy (kcal/mol) transmitted from the ATP-pocket perturbation at
    the kinase domain to each position: mild decay across the folded KD, then
    exponential decay through the disordered connector (correlation length
    lambda_flex in residues)."""
    mask = disorder_mask()
    flex = np.zeros(SEQ_LEN)
    acc = 0.0
    for i in range(SEQ_LEN):
        aa = i + 1
        if aa <= KD_RANGE[1]:
            flex[i] = 0.0
        else:
            acc += mask[i]
            flex[i] = acc
    prof = np.zeros(SEQ_LEN)
    for i in range(SEQ_LEN):
        aa = i + 1
        if aa <= KD_RANGE[0] - 1:
            prof[i] = dg0 * q_kd
        elif aa <= KD_RANGE[1]:
            prof[i] = dg0 * q_kd * np.exp(-(aa - KD_RANGE[0]) / lambda_kd)
        else:
            base = dg0 * q_kd * np.exp(-(KD_RANGE[1] - KD_RANGE[0]) / lambda_kd)
            prof[i] = base * np.exp(-flex[i] / lambda_flex)
    return prof

# ==============================================================
# 5.  Figure 1 : dual-axis dose-response decoupling
# ==============================================================
def make_figure1(head, sens_rows):
    d = head['dose']
    fig = plt.figure(figsize=(13.0, 5.7))
    gs = fig.add_gridspec(1, 2, width_ratios=[1.18, 1.0], wspace=0.24)

    # ---------- panel A : headline dual-axis divergence ----------
    ax1 = fig.add_subplot(gs[0, 0])
    ax2 = ax1.twinx()
    # in-vitro purified-enzyme curve (no ATP competition, no kappa dilution)
    ax1.plot(d, 100.0 * (1.0 / (1.0 + d / IC50_INVITRO_UM)), ls='--', lw=1.6,
             color='0.45', label='in vitro kinase activity (IC$_{50}$ = 0.5 nM)')
    # simulated in-cell catalytic occupancy (hub-resident TNIK active fraction)
    ax1.plot(d, 100.0 * head['active'], lw=2.2, color='#1f5fb0',
             label='in-cell catalytic activity (hub TNIK)')
    # simulated TopFlash reporter on the right axis
    ax2.plot(d, 100.0 * head['topflash'], lw=2.6, color='#c1272d',
             label='TopFlash / TCF reporter activity')

    ec_cat = ec50_log(d, head['active'])
    ec_top = ec50_log(d, head['topflash'])
    ec_ph  = ec50_log(d, head['phospho'])

    ax1.axvline(IC50_INVITRO_UM, color='0.35', ls=':', lw=1.0)
    ax1.text(IC50_INVITRO_UM, 2.0, 'in-vitro\nIC$_{50}$', rotation=90, fontsize=7.6,
             color='0.3', va='bottom', ha='right')
    ax1.axvline(ec_cat, color='#1f5fb0', ls=':', lw=1.1)
    ax1.text(ec_cat, 2.0, 'catalytic\nEC$_{50}$', rotation=90, fontsize=7.6,
             color='#1f5fb0', va='bottom', ha='right')
    ax1.axvline(ec_top, color='#c1272d', ls=':', lw=1.1)
    ax1.text(ec_top, 2.0, 'TopFlash\nEC$_{50}$', rotation=90, fontsize=7.6,
             color='#c1272d', va='bottom', ha='right')

    ax1.set_xscale('log'); ax2.set_xscale('log')
    ax1.set_xlabel('compound concentration  (µM, log)')
    ax1.set_ylabel('TNIK catalytic activity   (%)', color='#1f5fb0')
    ax2.set_ylabel('TopFlash transcriptional activity   (%)', color='#c1272d')
    ax1.set_xlim(d[0], d[-1]); ax1.set_ylim(0, 105); ax2.set_ylim(0, 105)
    ax1.tick_params(axis='y', colors='#1f5fb0')
    ax2.tick_params(axis='y', colors='#c1272d')

    ax1.axvspan(ec_cat, ec_top, color='gold', alpha=0.18, zorder=0)
    ax1.annotate('', xy=(ec_top, 95), xytext=(ec_cat, 95),
                 arrowprops=dict(arrowstyle='<->', color='#7a6a00', lw=1.4))
    ax1.text(np.sqrt(ec_cat * ec_top), 98,
             f'decoupling window\n{np.log10(ec_top / ec_cat):.2f} orders '
             '(scaffold retention + licensing)',
             ha='center', fontsize=8.2, color='#6b5d00')

    l1, la1 = ax1.get_legend_handles_labels()
    l2, la2 = ax2.get_legend_handles_labels()
    ax1.legend(l1 + l2, la1 + la2, loc='upper right', fontsize=7.8, framealpha=0.95)
    ax1.text(0.99, 0.02, 'x-axis: free compound for the purified-enzyme line;\n'
             'nominal (medium) dose for the cell curves',
             transform=ax1.transAxes, fontsize=7.0, color='0.35', ha='right',
             va='bottom')

    # ---------- panel B : kappa sensitivity of the TopFlash curve ----------
    ax = fig.add_subplot(gs[0, 1])
    cmap = colormaps['Purples_r']
    nk = max(len(sens_rows) - 1, 1)
    for j, r in enumerate(sens_rows):
        kappa = r['kappa']
        col = cmap(0.90 - 0.70 * j / nk)
        ax.plot(r['dose'], 100.0 * r['topflash'], lw=2.0, color=col,
                label=f'TopFlash, κ = {kappa:g}')
        e = ec50_log(r['dose'], r['topflash'])
        ax.plot([e], [62.5], 'o', ms=5, color=col)
        ax.annotate(f'EC$_{{50}}$ ≈ {e:.3g} µM', xy=(e, 62.5), xytext=(e, 68),
                    fontsize=7.2, color=col, ha='center',
                    arrowprops=dict(arrowstyle='-', lw=0.6, color=col))
    ax.plot(d, 100.0 * head['active'], ls='--', lw=1.4, color='#1f5fb0',
            label='catalytic activity (κ = 0.1)')
    ax.set_xscale('log'); ax.set_xlabel('compound concentration  (µM, log)')
    ax.set_ylabel('TopFlash activity   (%)')
    ax.set_ylim(0, 105); ax.set_xlim(d[0], d[-1])
    ax.set_title('Excluded free drug in the dense phase (κ < 1)\n'
                 'right-shifts and flattens the transcriptional curve',
                 fontsize=9.3)
    ax.legend(fontsize=7.6, framealpha=0.95, loc='upper right')
    ax.text(0.03, 0.04, 'plateau floor = TopFlash component\nindependent of TNIK '
            'catalysis', transform=ax.transAxes, fontsize=7.4, color='0.3')

    fig.suptitle('Enzymatic inhibition vs nuclear transcriptional output for an '
                 'ATP-competitive TNIK inhibitor\n'
                 '(intranuclear reaction–transport ODE model: cytosol → NPC → '
                 'LLPS hub, κ = free-drug partition dense/dilute)',
                 fontsize=10.8)
    fig.savefig('fig1_tnik_dose_response_decoupling.png', dpi=200,
                bbox_inches='tight')
    plt.close(fig)
    return dict(ec_cat_um=ec_cat, ec_top_um=ec_top, ec_phospho_um=ec_ph)

# ==============================================================
# 6.  Figure 2 : allosteric dissipation heatmap over full-length TNIK
# ==============================================================
def make_figure2():
    dg0_rows = np.array([0.5, 1.0, 1.5, 2.0, 2.5, 3.0])
    lam_flex = 10.0                 # correlation length of the disordered connector
    xs = np.arange(1, SEQ_LEN + 1)
    M = np.array([coupling_profile(dg0=g0, lambda_flex=lam_flex)
                  for g0 in dg0_rows])

    fig, (ax0, ax1) = plt.subplots(
        2, 1, figsize=(12.5, 5.7), sharex=True,
        gridspec_kw=dict(height_ratios=[0.62, 1.4], hspace=0.10))

    # ---------- top: domain cartoon ----------
    y = 0.30; hh = 0.40
    ax0.add_patch(Rectangle((KD_RANGE[0], y), KD_RANGE[1] - KD_RANGE[0], hh,
                            facecolor='#2166ac', edgecolor='k', lw=0.8))
    ax0.text(np.mean(KD_RANGE), y + hh / 2, 'kinase domain 25–289\n(TCF4 binding '
             '/ substrate docking)', ha='center', va='center', fontsize=8.4,
             color='white')
    ax0.add_patch(Rectangle((LINKER_RANGE[0], y), LINKER_RANGE[1] - LINKER_RANGE[0],
                            hh, facecolor='#b8d7ed', edgecolor='k', lw=0.8))
    ax0.text(np.mean(LINKER_RANGE), y + hh / 2,
             'long disordered / low-complexity connector 290–1046\n'
             '(β-catenin binding, NEDD4 site)', ha='center', va='center',
             fontsize=7.6, color='k')
    ax0.add_patch(Rectangle((CNH_RANGE[0], y), CNH_RANGE[1] - CNH_RANGE[0], hh,
                            facecolor='#b2182b', edgecolor='k', lw=0.8))
    ax0.text(np.mean(CNH_RANGE), y + hh / 2, 'CNH domain\n1047–1334',
             ha='center', va='center', fontsize=8.4, color='white')
    # disorder ticks inside the connector
    for (a, b) in DISORDER_RANGES:
        lo, hi = max(a, LINKER_RANGE[0]), min(b, LINKER_RANGE[1])
        if hi > lo:
            ax0.plot([lo, hi], [y - 0.04] * 2, color='k', lw=2.2)
    ax0.annotate('ATP pocket\nK54, D153', xy=(ATP_LYS, y), xytext=(70, 1.9),
                 fontsize=7.4, color='#1f5fb0', ha='center',
                 arrowprops=dict(arrowstyle='-', color='#1f5fb0', lw=0.8))
    ax0.annotate('β-cat / TCF4 scaffold\ninterfaces', xy=(0.55 * BCAT_BIND_RANGE[1],
                 y + hh), xytext=(760, 1.75), fontsize=8.0, color='#b2182b',
                 ha='center', arrowprops=dict(arrowstyle='-', color='#b2182b', lw=0.9))
    ax0.set_ylim(0, 2.15)
    ax0.set_yticks([])
    ax0.set_title('Allosteric free-energy dissipation along full-length TNIK '
                  '(Q9UKE5, 1360 aa)\n— an ATP-pocket perturbation cannot reach '
                  'the distal scaffold interfaces', fontsize=10.4, loc='left')
    ax0.text(0.997, 0.86, 'topology: UniProt; disordered ticks = 700+ aa of '
             'predicted disorder', transform=ax0.transAxes, ha='right',
             fontsize=7.2, color='0.35')

    # ---------- bottom: heatmap ----------
    xx = np.concatenate([[0], np.arange(1, SEQ_LEN + 1)])
    yy = np.concatenate([dg0_rows - 0.25, [dg0_rows[-1] + 0.25]])
    pcm = ax1.pcolormesh(xx, yy, M, cmap='magma', vmin=0.0, vmax=1.4,
                         shading='flat')
    cs = ax1.contour(xs, dg0_rows, M, levels=[0.06, 0.2, 0.6, 1.2],
                     colors='w', linewidths=0.7, alpha=0.75)
    ax1.clabel(cs, fmt='%.2g', fontsize=6.4)
    for xc in (BCAT_BIND_RANGE[0], LINKER_RANGE[1], CNH_RANGE[0]):
        ax1.axvline(xc, color='0.6', lw=0.6, ls=':')

    ax1.add_patch(Rectangle((BCAT_BIND_RANGE[0], dg0_rows[0] - 0.3),
                            BCAT_BIND_RANGE[1] - BCAT_BIND_RANGE[0],
                            dg0_rows[-1] - dg0_rows[0] + 0.6,
                            facecolor='none', edgecolor='#f7fbff', lw=1.2, ls='--'))
    ax1.add_patch(Rectangle((CNH_RANGE[0], dg0_rows[0] - 0.3),
                            CNH_RANGE[1] - CNH_RANGE[0],
                            dg0_rows[-1] - dg0_rows[0] + 0.6,
                            facecolor='none', edgecolor='#f7fbff', lw=1.2, ls='--'))
    ax1.text(0.5 * (BCAT_BIND_RANGE[0] + BCAT_BIND_RANGE[1]), 1.30,
             'ΔΔG << 0.1 kT\n(≤ ~1 % Kd shift;\nno physical disruption)',
             ha='center', fontsize=7.8, color='w')
    ax1.text(0.5 * (CNH_RANGE[0] + CNH_RANGE[1]), 1.30,
             'ΔΔG ≈ 0\n(thermodynamically\ndecoupled)', ha='center',
             fontsize=7.8, color='w')

    ax1.set_ylabel('coupling potential at ATP pocket  ΔG$_0$ (kcal/mol)\n'
                   'λ$_{connector}$ = 10 residues (disordered estimate)')
    ax1.set_xlabel('TNIK sequence position (aa)')
    ax1.set_yticks(dg0_rows)
    ax1.set_ylim(dg0_rows[0] - 0.3, dg0_rows[-1] + 0.3)
    ax1.set_xlim(0, SEQ_LEN)
    cb = fig.colorbar(pcm, ax=ax1, pad=0.015)
    cb.set_label('propagated coupling free energy  ΔΔG$_{coupling}$  (kcal/mol)')
    ax1.text(0.997, 0.02,
             'even ΔG0 = 3 kcal/mol at the pocket cannot lift the β-cat / CNH '
             'interfaces\nabove 0.1 kT (~10 % Kd shift) — an ATP-site drug binds '
             'the nucleotide pocket, not the PPI',
             transform=ax1.transAxes, ha='right', fontsize=7.8, color='0.9')
    fig.savefig('fig2_tnik_allosteric_dissipation.png', dpi=200,
                bbox_inches='tight')
    plt.close(fig)

# ==============================================================
# 7.  Run default scenario
# ==============================================================
def main():
    head_rows = simulate_dose_response(params_kappa(P['kappa']))
    head = dict(kappa=P['kappa'],
                dose=np.array([r['dose'] for r in head_rows]),
                active=np.array([r['active'] for r in head_rows]),
                phospho=np.array([r['phospho'] for r in head_rows]),
                topflash=np.array([r['topflash'] for r in head_rows]))

    sens_rows = []
    for k in P['kappa_range']:
        rows = simulate_dose_response(params_kappa(k))
        sens_rows.append(dict(kappa=k,
                              dose=np.array([r['dose'] for r in rows]),
                              active=np.array([r['active'] for r in rows]),
                              phospho=np.array([r['phospho'] for r in rows]),
                              topflash=np.array([r['topflash'] for r in rows])))

    fig1 = make_figure1(head, sens_rows)
    make_figure2()

    ec_cat = fig1['ec_cat_um']
    ec_ph  = fig1['ec_phospho_um']
    ec_top = fig1['ec_top_um']
    top_at_max = head['topflash'][-1]

    met = dict(
        ic50_invitro_nM=IC50_INVITRO_UM * 1e3,
        atp_multiplier_A_ATP=A_ATP,
        kd_app_cell_nM=KD_APP_UM * 1e3,
        ic50_atp_only_nM=IC50_ATPONLY_UM * 1e3,
        ec_cat_hub_uM=ec_cat,
        ec_phospho_uM=ec_ph,
        ec_topflash_uM=ec_top,
        topflash_floor_frac=P['tcf_floor'],
        topflash_at_maxdose_frac=float(top_at_max),
        shift_cat_vs_invitro_log10=np.log10(ec_cat / IC50_INVITRO_UM),
        shift_top_vs_invitro_log10=np.log10(ec_top / IC50_INVITRO_UM),
        shift_top_vs_cat_log10=np.log10(ec_top / ec_cat),
        shift_top_vs_atponly_log10=np.log10(ec_top / IC50_ATPONLY_UM),
        ec_topflash_by_kappa=[(k, ec50_log(r['dose'], r['topflash']))
                              for k, r in zip(P['kappa_range'], sens_rows)],
    )
    print('===== TNIK catalytic-vs-scaffold simulation metrics =====')
    for k, v in met.items():
        print(f'{k:30s} {v}')
    print('figures: fig1_tnik_dose_response_decoupling.png, '
          'fig2_tnik_allosteric_dissipation.png')
    return met

if __name__ == '__main__':
    main()
