#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==============================================================================
 lnp_endosomal_escape_thermodynamics.py
==============================================================================
Micro-physicochemical & kinetic model of mRNA-LNP endosomal escape failure
caused by premature lamellar -> inverted-hexagonal (L_alpha -> H_II) phase
collapse.  Semi-quantitative, literature-calibrated design tool.

Scope / question
----------------
A claimed "extreme" formulation (helper lipid DSPC fully replaced by the
conical DOPE, ionizable-lipid apparent pKa raised to ~6.8) is advertised to
give "instant 100% H_II at pH 6.0 in the early endosome" and >30 % escape by
directly tearing the endosomal membrane.  This script builds the physics that
refutes that claim and locates the real design optimum:

  (1) Molecular packing parameter S = v/(a0 * l_c) for DSPC vs DOPE;
  (2) Effective monolayer spontaneous curvature c0(pH) by area-weighted
      additivity (Marsh, 1996) and the resulting L_alpha/H_II stability
      (collapse) criterion;
  (3) A fusion-pore activation barrier DeltaG++(zeta) that is LOWERED by
      moderate negative curvature (hemifusion/stalk stabilization) but
      RAISED by excessive negative curvature (pore rim needs positive
      curvature -> hemifusion stall) and by internal bulk collapse;
  (4) A compartmental kinetic "race" along the endosomal pH(t) trajectory
      among PEG shedding, membrane engagement, pore opening (escape),
      internal H_II collapse (mRNA locking), recycling (NPC1-dependent) and
      lysosomal deposition -- the NPC1/cholesterol window.

Equations referenced in the companion report (numbers E1..E6 below):

  E1  S_i = v_i / (a0_i * l_c_i)                       (Israelachvili packing)
  E2  alpha(pH) = 1 / (1 + 10^(pH - pKa_app))          (Henderson-Hasselbalch)
  E3  c0(pH) = sum_i w_i c0_i(alpha)   ,  w_i area-wt  (Marsh additivity)
      zeta = -c0  (magnitude of negative curvature, nm^-1)
  E4  bulk H_II stable when zeta > zeta_crit (~0.30 /nm); driving
      D = N_lip * k_curv * (zeta - zeta_crit)   [kBT per particle]
      nucleation-like collapse barrier, capped (cross-link frustration);
  E5  DeltaG++_esc(zeta) = Em + a_esc (zeta - zeta_opt)^2 + cholesterol term
  E6  d/dt states: I -> A (engage), A -> R (release), I/A -> C (collapse),
      I -> Re (recycle), I/A/C -> Ly (lysosomal cargo); pH(t) maturation.

Units: nm, minutes, energies in kBT at 310 K.  Rates are particle-level
first-order constants.  The reference formulation is calibrated so that its
predicted net escape reproduces the experimentally reported ~1-2 %
(Gilleron et al., Nat. Biotechnol. 31, 638, 2013) single-particle benchmark.

Usage
-----
  python3 lnp_endosomal_escape_thermodynamics.py [outdir]
writes CSV tables + 5 multi-panel PNG figures into the current directory
(or outdir).  Requires numpy + matplotlib only.
==============================================================================
"""

from __future__ import annotations

import sys, os, math
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon

# ----------------------------------------------------------------------------
# 0. Global configuration (single place to tune; see report, App. B)
# ----------------------------------------------------------------------------
CONFIG = dict(
    T=310.0,                    # K (body temperature)
    # -- lipid geometry / packing (E1) --------------------------------------
    TANFORD=(27.4, 26.9),       # v_chain[nm3] ~ (27.4 + 26.9*nc) * 1e-3 (Tanford 1980)
    CHAIN_NC=18,                # both DSPC (18:0) and DOPE (18:1 delta9-cis)
    A_DSPC=0.66,                # nm2, phosphocholine headgroup, fluid L_alpha (Nagle)
    A_DOPE=0.56,                # nm2, phosphoethanolamine headgroup, H_II pivotal plane
    LC_FLUID_FRAC=0.72,         # effective l_c as fraction of all-trans l_max
    LMAX_CONST=(1.54, 1.265),   # l_max [nm] = 1.54 + 1.265*(n_eff-1), n_eff reduced by cis-kink
    KINK_NRED=1.0,              # each cis double bond shortens chain ~1 CH2-equivalent
    # -- composition (mol fractions, PEG excluded then renormalised) --------
    X_IL=0.508, X_CHOL=0.391, X_HELPER=0.102,   # ~ 50:38.5:10 non-PEG core
    # -- per-lipid monolayer spontaneous curvature c0 (nm^-1) & area (nm2) --
    C0_IL_NEUT=-0.12,           # deprotonated ionizable lipid
    DC0_IL=-0.42,               # extra negative curvature per unit protonation
    C0_CHOL=-0.05,
    C0_DSPC=-0.02, C0_DOPE=-0.48,
    A_IL=0.62, A_CHOL=0.38,
    # -- phase / curvature thresholds ---------------------------------------
    ZETA_CRIT=0.30,             # H_II stable for zeta>ZETA_CRIT (Gruner-type criterion)
    K_CURV=0.15,                # kBT per lipid per (nm^-1) of zeta overshoot
    N_LIP=2.0e5,                # lipids per ~100 nm LNP
    COL_G0=20.0, COL_SLOPE=6.0, COL_MIN=3.0, K_COL0=1.0e5,
    # -- escape barrier (E5) -------------------------------------------------
    EM=10.0, A_ESC=700.0, ZETA_OPT=0.235, A_ESC_RATE=800.0,
    # -- NPC1 / cholesterol --------------------------------------------------
    CHI_BASE=0.20, CHI_AMP=0.22, CHI_TAU=15.0, K_CHOL=5.0,
    K_RECYC_N1=0.02,            # recycling rate at full NPC1 activity (1/min)
    REC_TAU=25.0,               # recycling decays with maturation time (min)
    # -- endosomal trajectory (E6) ------------------------------------------
    PHT=(4.85, 1.30, 3.50, 1.25, 22.0),   # pH(t)=P0+A1 e^-t/T1 + A2 e^-t/T2
    TAU_PEG=6.0, THETA_CRIT=0.40,
    K_ENG=0.40, K_DIS=0.02,
    K_LYS_PH=5.45, K_LYS=0.06,
    K_ESC_PH_GATE=6.9,
    DT=0.05, TMAX=120.0,
)

# ----------------------------------------------------------------------------
# 1. Molecular packing parameter (E1)
# ----------------------------------------------------------------------------
def tanford_chain_volume(nc: int) -> float:
    """Hydrocarbon chain volume in nm^3 (Tanford 1980 approximation)."""
    c27, c26 = CONFIG["TANFORD"]
    return (c27 + c26 * nc) * 1e-3          # per chain

def chain_max_length(nc: int, n_double: int = 0) -> float:
    """All-trans maximum hydrocarbon length in nm; cis-kink shortens chain."""
    c15, c12 = CONFIG["LMAX_CONST"]
    n_eff = nc - 1 - CONFIG["KINK_NRED"] * n_double
    return (c15 + c12 * n_eff) / 10.0        # nm

def packing_parameter_s(v: float, a0: float, lc: float) -> float:
    return v / (a0 * lc)

def lipid_geometry_table() -> list[dict]:
    rows = []
    for name, n_double, a0 in (("DSPC", 0, CONFIG["A_DSPC"]),
                               ("DOPE", 1, CONFIG["A_DOPE"])):
        v = 2.0 * tanford_chain_volume(CONFIG["CHAIN_NC"])
        lmax = chain_max_length(CONFIG["CHAIN_NC"], n_double)
        lc = CONFIG["LC_FLUID_FRAC"] * lmax
        rows.append(dict(name=name, v_nm3=v, a0_nm2=a0, lc_nm=lc,
                         S=packing_parameter_s(v, a0, lc)))
    return rows

# ----------------------------------------------------------------------------
# 2. Protonation, effective curvature, phase driving force (E2-E4)
# ----------------------------------------------------------------------------
def alpha(pH: float, pKa: float) -> float:
    """Fraction of ionizable lipid that is protonated (cationic). E2."""
    return 1.0 / (1.0 + 10.0 ** (pH - pKa))

def zeta_core(pH: float, pKa: float, phi_DOPE: float) -> float:
    """Magnitude |c0| of effective core negative curvature (nm^-1), E3.

    phi_DOPE is the DOPE fraction *within the helper-lipid pool*
    (0 -> all DSPC, 1 -> all DOPE).  Area-weighted additivity (Marsh 1996).
    """
    a = alpha(pH, pKa)
    A_h = phi_DOPE * CONFIG["A_DOPE"] + (1 - phi_DOPE) * CONFIG["A_DSPC"]
    w_il = CONFIG["X_IL"] * CONFIG["A_IL"]
    w_ch = CONFIG["X_CHOL"] * CONFIG["A_CHOL"]
    w_h  = CONFIG["X_HELPER"] * A_h
    tot = w_il + w_ch + w_h
    c0_il = CONFIG["C0_IL_NEUT"] + CONFIG["DC0_IL"] * a
    c0_h  = phi_DOPE * CONFIG["C0_DOPE"] + (1 - phi_DOPE) * CONFIG["C0_DSPC"]
    c0 = (w_il * c0_il + w_ch * CONFIG["C0_CHOL"] + w_h * c0_h) / tot
    return -c0

def bulk_driving_D(pH: float, pKa: float, phi_DOPE: float) -> float:
    """Thermodynamic driving force toward internal bulk H_II (kBT/particle).
    >0 means the condensed core prefers inverted phase (E4)."""
    z = zeta_core(pH, pKa, phi_DOPE)
    if z <= CONFIG["ZETA_CRIT"]:
        return 0.0
    return CONFIG["N_LIP"] * CONFIG["K_CURV"] * (z - CONFIG["ZETA_CRIT"])

def collapse_barrier_kBT(D: float) -> float:
    """Nucleation-like barrier to internal collapse.  Cross-link frustration
    keeps it finite even at large driving (no instantaneous 100 % H_II)."""
    if D <= 0.0:
        return float("inf")
    b = CONFIG["COL_G0"] - CONFIG["COL_SLOPE"] * (D / 1000.0)
    return max(CONFIG["COL_MIN"], b)

def collapse_rate_1min(D: float) -> float:
    if D <= 0.0:
        return 0.0
    return CONFIG["K_COL0"] * math.exp(-collapse_barrier_kBT(D))

def escape_barrier_kBT(zeta: float, chi: float) -> float:
    """Fusion-pore activation barrier (kBT), E5.

    Quadratic minimum at zeta_opt: weak curvature cannot form a stalk,
    excessive curvature stalls the pore rim (positive-curvature element) and
    pre-empts release by bulk collapse.  NPC1 cholesterol loading stiffens
    the endosomal membrane (chi = its cholesterol mole fraction).
    """
    b = (CONFIG["EM"]
         + CONFIG["A_ESC"] * (zeta - CONFIG["ZETA_OPT"]) ** 2)
    if chi > 0.22:
        b += CONFIG["K_CHOL"] * (chi - 0.22)
    return b

def escape_rate_1min(zeta: float, chi: float) -> float:
    return CONFIG["A_ESC_RATE"] * math.exp(-escape_barrier_kBT(zeta, chi))

def phi_DOPE_of_pKa_helpermix(helper: str) -> float:
    return 0.0 if helper == "DSPC" else (1.0 if helper == "DOPE" else float("nan"))

# ----------------------------------------------------------------------------
# 3. Endosomal trajectory and NPC1-dependent cholesterol (E6)
# ----------------------------------------------------------------------------
def endosomal_pH(t: float) -> float:
    p0, a1, t1, a2, t2 = CONFIG["PHT"]
    return p0 + a1 * math.exp(-t / t1) + a2 * math.exp(-t / t2)

def peg_coverage(t: float) -> float:
    return math.exp(-t / CONFIG["TAU_PEG"])

def endo_cholesterol(t: float, npc1: float) -> float:
    """Endosomal/lysosomal membrane cholesterol mole fraction vs NPC1 level.
    NPC1 exports cholesterol; high NPC1 -> low membrane cholesterol."""
    return CONFIG["CHI_BASE"] + CONFIG["CHI_AMP"] * (1 - npc1) * (
        1 - math.exp(-t / CONFIG["CHI_TAU"]))

# ----------------------------------------------------------------------------
# 4. Compartmental race ODE (E6)
# ----------------------------------------------------------------------------
def simulate(pKa: float, phi_DOPE: float, npc1: float) -> dict:
    """Integrate the endosomal race. States (fractions of internalized LNP):

        I  intact particle in vesicle lumen
        A  engaged / membrane-competent (PEG shed, apposed)
        R  released mRNA to cytosol   (the success channel)
        C  internal H_II collapsed / mRNA-locked aggregate
        Ly lysosome-localised cargo (deposited for degradation / accumulation)
        Re recycled back to the extracellular space (NPC1-dependent)

    Returns time arrays + final metrics.
    """
    cfg = CONFIG
    dt, T = cfg["DT"], cfg["TMAX"]
    n = int(round(T / dt)) + 1
    ts = np.zeros(n); pHs = np.zeros(n); zs = np.zeros(n); chis = np.zeros(n)
    I = np.zeros(n); A = np.zeros(n); R = np.zeros(n)
    C = np.zeros(n); Ly = np.zeros(n); Re = np.zeros(n)
    kesc = np.zeros(n); kcol = np.zeros(n)
    I[0] = 1.0
    k_dis = cfg["K_DIS"]
    for k in range(n - 1):
        t = k * dt
        pH = endosomal_pH(t)
        theta = peg_coverage(t)
        chi = endo_cholesterol(t, npc1)
        z = zeta_core(pH, pKa, phi_DOPE)
        D = bulk_driving_D(pH, pKa, phi_DOPE)
        kgate = 1.0 / (1.0 + math.exp((pH - cfg["K_ESC_PH_GATE"]) / 0.08))
        g_peg = 1.0 / (1.0 + math.exp((theta - cfg["THETA_CRIT"]) / 0.06))
        ke = cfg["A_ESC_RATE"] * math.exp(-escape_barrier_kBT(z, chi))
        kc = collapse_rate_1min(D)
        keng = cfg["K_ENG"] * g_peg * kgate
        krec = cfg["K_RECYC_N1"] * (npc1 ** 1.4) * math.exp(-t / cfg["REC_TAU"])
        lys_on = pH < cfg["K_LYS_PH"]
        klys = cfg["K_LYS"] if lys_on else 0.0
        klys_c = 0.05 if lys_on else 0.0

        i, a, r, c, ly, re = I[k], A[k], R[k], C[k], Ly[k], Re[k]

        # exact competing-exit integration (mass conserving for any rate size):
        #   P(exit in dt) = 1 - exp(-R dt); split P among channels by hazard.
        # I (lumen): exits -> engage (A), collapse (C), recycle (Re), lysosome (Ly)
        R_I = keng + kc + krec + klys
        if R_I > 0.0 and i > 0.0:
            out = i * (1.0 - math.exp(-R_I * dt))
            i -= out
            a  += out * (keng / R_I)
            c  += out * (kc   / R_I)
            re += out * (krec / R_I)
            ly += out * (klys / R_I)
        # A (engaged): exits -> release (R), collapse (C), disengage->I,
        #               recycling (Re, NPC1-gated), lysosome (Ly)
        R_A = ke + kc + k_dis + krec + klys
        if R_A > 0.0 and a > 0.0:
            out = a * (1.0 - math.exp(-R_A * dt))
            a -= out
            r  += out * (ke    / R_A)
            c  += out * (kc    / R_A)
            i  += out * (k_dis / R_A)
            re += out * (krec  / R_A)
            ly += out * (klys  / R_A)
        # C (collapsed aggregate): delivered to lysosome once compartment acidifies
        if klys_c > 0.0 and c > 0.0:
            out = c * (1.0 - math.exp(-klys_c * dt))
            c -= out
            ly += out

        I[k + 1], A[k + 1], R[k + 1], C[k + 1], Ly[k + 1], Re[k + 1] = i, a, r, c, ly, re
        ts[k + 1] = t + dt
        pHs[k + 1] = endosomal_pH(t + dt)
        zs[k + 1] = zeta_core(pHs[k + 1], pKa, phi_DOPE)
        chis[k + 1] = chi
        kesc[k + 1] = ke
        kcol[k + 1] = kc

    # -- fusogenic window metric -------------------------------------------
    # times when: PEG off, particle not yet collapsing, barrier < Em+4 kBT
    win = []
    for k in range(n):
        if peg_coverage(ts[k]) < cfg["THETA_CRIT"] \
           and bulk_driving_D(pHs[k], pKa, phi_DOPE) <= 0.0 \
           and escape_barrier_kBT(zs[k], 0.22) < CONFIG["EM"] + 4.0:
            win.append(ts[k])
    w_start = win[0] if win else np.nan
    w_end = win[-1] if win else np.nan

    def frac(arr): return arr[-1]
    pk = int(np.argmax(C))
    return dict(t=ts, pH=pHs, zeta=zs, chi=chis, I=I, A=A, R=R, C=C, Ly=Ly, Re=Re,
                kesc=kesc, kcol=kcol,
                released=frac(R), collapsed=frac(C), lysosomal=frac(Ly),
                recycled=frac(Re), intact=frac(I) + frac(A),
                peak_collapsed=C[pk], t_peak_collapsed=ts[pk],
                window=(w_start, w_end))

# ----------------------------------------------------------------------------
# 5. Named formulations & end-of-run summary
# ----------------------------------------------------------------------------
FORMULATIONS = {
    #  name  : (pKa, phi_DOPE, color, ls,  tag)
    "REF (MC3/DSPC-like)": dict(pKa=6.44, phi=0.00, color="#1f77b4", ls="-",
                                 tag="reference, calibrated ~1-2%"),
    "EXT (all-DOPE, pKa 6.8)": dict(pKa=6.80, phi=1.00, color="#d62728", ls="-",
                                     tag="claimed 'extreme' formulation"),
}
NPC1_LEVELS = {"high NPC1": 1.0, "normal": 0.5, "low/inhibited": 0.1}

def characteristic_pHs(pKa, phi):
    """pH at which: (a) fusion barrier is minimal, (b) bulk H_II collapse onset
    (the HIGHEST pH at which the condensed core becomes H_II-favoured, i.e. the
    pH a maturing endosome crosses into the collapse regime)."""
    # minimal escape barrier: zeta = zeta_opt (single crossing as pH falls)
    pH_opt = None
    zprev, pHprev = zeta_core(8.0, pKa, phi), 8.0
    for i in range(1, 4491):
        pH = 8.0 - i * (8.0 - 3.5) / 4491.0
        z = zeta_core(pH, pKa, phi)
        if zprev <= CONFIG["ZETA_OPT"] <= z:     # crossing while pH falls
            fr = (CONFIG["ZETA_OPT"] - zprev) / (z - zprev + 1e-12)
            pH_opt = pHprev * (1.0 - fr) + pH * fr
            break
        zprev, pHprev = z, pH
    # collapse onset: scan from high pH downward, first pH with zeta >= zeta_crit
    pH_col = None
    for pH in np.linspace(8.0, 3.5, 901):
        if zeta_core(pH, pKa, phi) >= CONFIG["ZETA_CRIT"]:
            pH_col = pH
            break
    return pH_opt, pH_col

# ----------------------------------------------------------------------------
# 6. Design-space scan (the "dead zone" map)
# ----------------------------------------------------------------------------
def uptake_weight(pKa):
    """pKa-dependent internalisation weighting for the hepatic/ApoE pathway.

    Empirical in-vivo pKa SAR for hepatocyte silencing is bell-shaped with an
    optimum ~6.2-6.5 (Jayaraman et al. 2012): at too-low pKa the particle is
    inert in the circulation/ApoE corona is poor; at too-high pKa the surface
    carries charge at pH 7.4 -> serum protein binding, mis-routing, clearance.
    The endosomal-escape model alone (above) does NOT contain these pre-
    endosomal steps, so we apply this documented filter when reporting
    in-vivo-relevant net delivery."""
    return math.exp(-((pKa - 6.35) / 0.35) ** 2)

def release_efficiency_grid(dt_g=0.1, tmax_g=90.0, weighted=True):
    """Net mRNA delivered (fraction, NPC1=normal) over the (pKa x DOPE) plane.

    Endosomal-stage release from `simulate`, optionally multiplied by the
    pKa-dependent ApoE/hepatic uptake weight.  Returns X,Y,Z (%*100 later)."""
    pKas = np.arange(6.00, 7.21, 0.05)
    phis = np.arange(0.0, 1.001, 0.05)
    X, Y = np.meshgrid(pKas, phis)
    Z = np.full_like(X, np.nan)
    save = CONFIG["DT"], CONFIG["TMAX"]
    CONFIG["DT"], CONFIG["TMAX"] = dt_g, tmax_g
    for j, pka in enumerate(pKas):
        w = uptake_weight(pka) if weighted else 1.0
        for i, phi in enumerate(phis):
            Z[i, j] = simulate(pka, phi, npc1=0.5)["released"] * w
    CONFIG["DT"], CONFIG["TMAX"] = save
    return X, Y, Z

# ----------------------------------------------------------------------------
# 7. Figures
# ----------------------------------------------------------------------------
COMPT_BANDS = [("early EE", 7.2, 6.2, "#cfe3f5"), ("LE", 6.2, 5.5, "#d9ead3"),
               ("Lyso", 5.5, 4.6, "#f4cccc")]

def _compt_shading(ax, xmin=0.0, xmax=120.0):
    for name, hi, lo, col in COMPT_BANDS:
        # convert pH band to time via inverse of endosomal_pH at 3 sample pHs
        tlo = _time_at_pH(hi); thi = _time_at_pH(lo)
        ax.axvspan(max(xmin, tlo), min(xmax, thi), color=col, alpha=0.35, zorder=0)

def _time_at_pH(target):
    t = 0.0
    while t < 200:
        if endosomal_pH(t) <= target:
            break
        t += 0.05
    return t

def save_csv(name, rows):
    import csv
    with open(name, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)

def make_fig1(outdir):
    """Packing geometry + curvature-vs-pH (nucleation of the flaw)."""
    fig = plt.figure(figsize=(12.5, 4.6))
    axA = fig.add_subplot(1, 2, 1)
    rows = lipid_geometry_table()
    names = [r["name"] for r in rows]
    vals  = [r["S"] for r in rows]
    cols  = ["#4C72B0", "#C44E52"]
    bars = axA.bar(names, vals, color=cols, width=0.55, edgecolor="k", lw=0.6)
    axA.axhline(1.0, color="0.25", lw=1.2, ls="--")
    axA.text(1.62, 1.02, "S = 1  (cylinder, lamellar)", fontsize=8.5, color="0.2", ha="right")
    for b, r in zip(bars, rows):
        axA.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.02,
                 f"S = {r['S']:.2f}\nv={r['v_nm3']:.2f} nm$^3$  a$_0$={r['a0_nm2']:.2f} nm$^2$",
                 ha="center", fontsize=8)
    # simple shape insets: rectangle (DSPC cylinder) / trapezoid (DOPE cone)
    inset = axA.inset_axes([0.08, 0.05, 0.28, 0.30])
    inset.add_patch(plt.Rectangle((0.25, 0.25), 0.5, 0.45, color="#9ecae1", ec="k"))
    inset.text(0.5, 0.12, "DSPC: cylinder", ha="center", fontsize=7)
    inset.set_xlim(0, 1); inset.set_ylim(0, 1); inset.axis("off")
    inset2 = axA.inset_axes([0.60, 0.05, 0.30, 0.30])
    inset2.add_patch(Polygon([(0.18, 0.30), (0.82, 0.30), (0.62, 0.75), (0.38, 0.75)],
                             color="#f4a6a6", ec="k"))
    inset2.text(0.5, 0.10, "DOPE: cone (S>1)", ha="center", fontsize=7)
    inset2.set_xlim(0, 1); inset2.set_ylim(0, 1); inset2.axis("off")
    axA.set_ylabel("packing parameter  S = v / (a$_0$ l$_c$)")
    axA.set_title("A  Molecular packing: DSPC vs DOPE (E1)", fontsize=10)
    axA.set_ylim(0, 1.5)
    axA.set_xlim(-0.6, 1.6)

    axB = fig.add_subplot(1, 2, 2)
    pHs = np.linspace(4.6, 7.6, 400)
    for tag, d in FORMULATIONS.items():
        z = np.array([zeta_core(p, d["pKa"], d["phi"]) for p in pHs])
        axB.plot(pHs, z, color=d["color"], lw=2.2, label=f"{tag}  (pKa={d['pKa']:.2f})")
    axB.axhline(CONFIG["ZETA_CRIT"], color="0.3", ls="--", lw=1.2)
    axB.text(7.55, CONFIG["ZETA_CRIT"] + 0.006, "H$_{II}$ stable (bulk collapse) threshold",
             fontsize=7.5, color="0.2", ha="right")
    axB.axhline(CONFIG["ZETA_OPT"], color="#2ca02c", ls=":", lw=1.4)
    axB.text(7.55, CONFIG["ZETA_OPT"] + 0.005, "optimal fusion barrier (ζ*)",
             fontsize=7.5, color="#2ca02c", ha="right")
    for name, hi, lo, col in COMPT_BANDS:
        axB.axvspan(lo, hi, color=col, alpha=0.30, zorder=0)
        axB.text((lo + hi) / 2, 0.415, name, ha="center", fontsize=7, color="0.25", rotation=90)
    axB.set_xlabel("lumen / plasma pH")
    axB.set_ylabel("net negative curvature  ζ = −c$_0$   (nm$^{-1}$)")
    axB.set_title("B  Curvature load vs pH: EXT is H$_{II}$-prone by pH ≈ 6.3", fontsize=10)
    axB.set_xlim(4.6, 7.6); axB.set_ylim(0.05, 0.45)
    axB.legend(fontsize=7.5, loc="upper right")
    fig.tight_layout()
    p = str(Path(outdir) / "fig1_geometry_packing_vs_pH.png")
    fig.savefig(p, dpi=160, bbox_inches="tight"); plt.close(fig); return p

def make_fig2(outdir):
    """Thermodynamic L_alpha / H_II (collapse) phase map in (pH x phi_DOPE)."""
    pHs = np.linspace(4.6, 7.6, 601)
    phis = np.linspace(0, 1, 121)
    fig, axes = plt.subplots(1, 2, figsize=(12.6, 4.5), sharey=True)
    for ax, pKa in zip(axes, (6.44, 6.80)):
        P, Q = np.meshgrid(pHs, phis)
        H = np.array([[zeta_core(p, pKa, q) - CONFIG["ZETA_CRIT"] for p in pHs]
                      for q in phis])      # >0 => bulk H_II (collapse) preferred
        pc = ax.pcolormesh(P, Q, H, cmap="coolwarm", vmin=-0.10, vmax=0.12, shading="auto")
        cs = ax.contour(P, Q, H, levels=[0.0], colors="k", linewidths=2.0)
        ax.clabel(cs, fmt={0.0: "L$_\\alpha$↔H$_{II}$ boundary"})
        for name, hi, lo, col in COMPT_BANDS:
            ax.axvspan(lo, hi, color=col, alpha=0.13, zorder=3)
        ax.set_xlabel("pH")
        ax.set_title("pKa = " + f"{pKa:.2f}" + ":  phase preference of the condensed core\n"
                     "(red = bulk H$_{II}$-favoured; blue = L$_\\alpha$/disordered)", fontsize=9.5)
        if pKa == 6.80:
            ax.axhline(1.0, color="#d62728", lw=1.6, ls=":")
            ax.text(7.35, 0.965, "EXT (all-DOPE)", color="#d62728", fontsize=8.5, ha="center")
    axes[0].set_ylabel("DOPE fraction of helper lipid  φ$_{DOPE}$")
    fig.colorbar(pc, ax=axes, label="curvature over-shoot  ζ − ζ$_{crit}$  (nm$^{-1}$)",
                 shrink=0.85)
    fig.suptitle("Thermodynamic L$_\\alpha$→H$_{II}$ collapse map (E4): higher pKa + DOPE shift the "
                 "collapse boundary to HIGHER pH (earlier compartment)", fontsize=10.5, y=1.02)
    fig.subplots_adjust(wspace=0.30, top=0.82, bottom=0.13, left=0.09, right=0.90)
    p = str(Path(outdir) / "fig2_phase_map_pH_vs_DOPE.png")
    fig.savefig(p, dpi=160, bbox_inches="tight"); plt.close(fig); return p

def make_fig3(outdir):
    """Fusion-pore activation barrier landscape: curves, contour, 3D."""
    fig = plt.figure(figsize=(13.2, 4.4))
    axA = fig.add_subplot(1, 3, 1)
    pHs = np.linspace(4.6, 7.6, 300)
    for tag, d in FORMULATIONS.items():
        g = [escape_barrier_kBT(zeta_core(p, d["pKa"], d["phi"]), chi=0.22) for p in pHs]
        axA.plot(pHs, g, color=d["color"], lw=2.2, label=tag)
        im = int(np.argmin(g))
        axA.annotate(f"ΔG‡ min ≈ {g[im]:.1f} kBT at pH {pHs[im]:.2f}",
                     xy=(pHs[im], g[im]), xytext=(pHs[im] - 0.05, g[im] + 2.4),
                     fontsize=7.5, color=d["color"], ha="center",
                     arrowprops=dict(arrowstyle="->", color=d["color"], lw=0.8))
    for name, hi, lo, col in COMPT_BANDS:
        axA.axvspan(lo, hi, color=col, alpha=0.25, zorder=0)
    axA.set_xlabel("pH"); axA.set_ylabel("fusion-pore activation barrier  ΔG‡  (k$_B$T)")
    axA.set_title("A  Pore barrier vs pH\n(EXT minimum sits at pH≈7: misplaced fusogenicity)", fontsize=9)
    axA.legend(fontsize=7.5); axA.set_xlim(4.6, 7.6); axA.set_ylim(9, 30)

    axB = fig.add_subplot(1, 3, 2)
    pHs = np.linspace(4.6, 7.6, 200); phis = np.linspace(0, 1, 80)
    P, Q = np.meshgrid(pHs, phis)
    G = np.array([[escape_barrier_kBT(zeta_core(p, 6.80, q), 0.22) for p in pHs] for q in phis])
    D = np.array([[bulk_driving_D(p, 6.80, q) for p in pHs] for q in phis])
    cf = axB.contourf(P, Q, G, levels=np.linspace(10, 30, 21), cmap="magma_r")
    axB.contour(P, Q, D, levels=[0.0], colors="#2ca02c", linewidths=2.0)
    axB.text(4.85, 0.98, "green curve: bulk H$_{II}$ collapse onset\n(left/lower side: mRNA locked, fig. 2)",
             color="#2ca02c", fontsize=7)
    axB.set_xlabel("pH"); axB.set_ylabel("φ$_{DOPE}$ (of helper)")
    axB.set_title("B  Activation barrier ΔG‡ contour, pKa=6.8\n(magma = barrier height; low near pH≈7 = misplaced)",
                  fontsize=9)
    fig.colorbar(cf, ax=axB, label="k$_B$T")

    axC = fig.add_subplot(1, 3, 3, projection="3d")
    pHs = np.linspace(4.8, 7.4, 60); phis = np.linspace(0, 1, 40)
    P, Q = np.meshgrid(pHs, phis)
    G = np.array([[escape_barrier_kBT(zeta_core(p, 6.80, q), 0.22) for p in pHs] for q in phis])
    axC.plot_surface(P, Q, G, cmap="magma_r", rstride=1, cstride=1, lw=0, alpha=0.95,
                     antialiased=True)
    axC.contour(P, Q, G, zdir="z", offset=8.5, levels=np.linspace(10, 30, 11), cmap="magma_r",
                linewidths=0.5)
    axC.set_xlabel("pH"); axC.set_ylabel("φ$_{DOPE}$"); axC.set_zlabel("ΔG‡  (k$_B$T)")
    axC.set_title("C  Barrier surface, pKa=6.8", fontsize=9)
    axC.set_zlim(8.5, 32)
    fig.suptitle("Fusion-pore activation barrier landscape (E5): the escape minimum is an interior ridge, "
                 "not a monotonic function of curvature", fontsize=10.5, y=1.02)
    fig.subplots_adjust(left=0.05, right=0.99, top=0.82, bottom=0.12, wspace=0.30)
    p = str(Path(outdir) / "fig3_fusion_barrier_landscape.png")
    fig.savefig(p, dpi=160, bbox_inches="tight"); plt.close(fig); return p

def make_fig4(outdir):
    """Kinetic race timeline for REF vs EXT + NPC1 scenarios."""
    T = np.arange(0, 90, 0.1)
    fig = plt.figure(figsize=(13.4, 8.6))
    # panel A: pH(t), protonation, PEG
    axA = fig.add_subplot(2, 2, 1)
    pHa = [endosomal_pH(t) for t in T]
    axA.plot(T, pHa, color="0.2", lw=2.0, label="endosomal pH")
    axA.set_ylabel("endosomal pH", color="0.2")
    axA.set_ylim(4.6, 7.6)
    axA2 = axA.twinx()
    for tag, d in FORMULATIONS.items():
        al = [alpha(t, d["pKa"]) for t in T]
        axA2.plot(T, al, color=d["color"], ls="--", lw=1.6,
                  label=f"{tag}: α (protonated)")
    axA2.set_ylabel("ionizable-lipid protonation α", color="#444")
    axA2.set_ylim(0, 1.05)
    _compt_shading(axA)
    axA.set_title("A  Endosomal maturation trajectory", fontsize=9.5)
    h1, l1 = axA.get_legend_handles_labels()
    h2, l2 = axA2.get_legend_handles_labels()
    axA.legend(h1 + h2, l1 + l2, loc="center right", fontsize=6.5)

    def draw_pop(ax, pKa, phi, npc1, col):
        s = simulate(pKa, phi, npc1)
        m = s["t"] <= 90
        ax.plot(s["t"][m], s["I"][m] + s["A"][m], color=col, lw=1.8, label="intact (I+A)")
        ax.plot(s["t"][m], s["R"][m], color="#2ca02c", lw=2.2, label="released mRNA")
        ax.plot(s["t"][m], s["C"][m], color="#8c564b", lw=1.8, ls="--", label="collapsed/locked")
        ax.plot(s["t"][m], s["Ly"][m], color="#9467bd", lw=1.8, ls=":", label="lysosomal cargo")
        ax.plot(s["t"][m], s["Re"][m], color="#7f7f7f", lw=1.4, ls="-.", label="recycled")
        _compt_shading(ax)
        return s

    axB = fig.add_subplot(2, 2, 2)
    sB = draw_pop(axB, FORMULATIONS["REF (MC3/DSPC-like)"]["pKa"],
                  FORMULATIONS["REF (MC3/DSPC-like)"]["phi"], 0.5, "#1f77b4")
    axB.set_title("B  REF (pKa 6.44, DSPC): slow partial escape from LE", fontsize=9.5)
    axB.set_ylabel("fraction of internalized LNP")
    axB.legend(fontsize=6.5, loc="center right")

    axC = fig.add_subplot(2, 2, 3)
    sC = draw_pop(axC, FORMULATIONS["EXT (all-DOPE, pKa 6.8)"]["pKa"],
                  FORMULATIONS["EXT (all-DOPE, pKa 6.8)"]["phi"], 0.5, "#d62728")
    axC.set_title("C  EXT (all-DOPE, pKa 6.8): early collapse, ~zero release", fontsize=9.5)
    axC.set_xlabel("time (min)"); axC.set_ylabel("fraction of internalized LNP")

    axD = fig.add_subplot(2, 2, 4)
    relmax = _max_release()
    for tag, d in FORMULATIONS.items():
        for nlab, nv in NPC1_LEVELS.items():
            s = simulate(d["pKa"], d["phi"], nv)
            md = s["t"] <= 90
            st = "-" if nlab == "normal" else (":" if nlab == "low/inhibited" else "--")
            axD.plot(s["t"][md], 100 * s["R"][md], color=d["color"], ls=st, lw=1.6, alpha=0.9,
                     label=f"{tag}, {nlab}")
    axD.set_xlabel("time (min)"); axD.set_ylabel("cumulative mRNA released  (%)")
    axD.set_ylim(0, 100 * 1.15 * max(0.01, relmax))
    axD.set_title("D  Release kinetics vs NPC1 activity", fontsize=9.5)
    axD.legend(fontsize=6.5, ncol=2, loc="upper left")
    for ax in (axA, axB, axC, axD):
        ax.set_xlim(0, 90)
        ax.set_xlabel(ax.get_xlabel() or "time (min)")
    fig.tight_layout()
    p = str(Path(outdir) / "fig4_race_timeline.png")
    fig.savefig(p, dpi=160, bbox_inches="tight"); plt.close(fig); return p

def _max_release():
    mx = 0.0
    for tag, d in FORMULATIONS.items():
        for nv in NPC1_LEVELS.values():
            mx = max(mx, simulate(d["pKa"], d["phi"], nv)["released"])
    return mx

def make_fig5(outdir, X, Y, Z):
    """Design-plane map: net escape vs (pKa, phi_DOPE) -- the dead zone."""
    fig, ax = plt.subplots(figsize=(7.6, 5.2))
    Zp = np.clip(Z * 100, 0, None)
    pc = ax.pcolormesh(X, Y, Zp, cmap="viridis", shading="auto")
    cs = ax.contour(X, Y, Zp, levels=[0.5, 1, 2, 3, 4, 5, 6, 8], colors="w", linewidths=0.7,
                    alpha=0.7)
    ax.clabel(cs, fmt="%.1f%%", fontsize=7)
    # locate grid optimum & markers
    idx = np.unravel_index(np.nanargmax(Zp), Zp.shape)
    ax.plot(X[0, idx[1]], Y[idx[0], 0], marker="*", ms=15, color="#2ca02c",
            markeredgecolor="w", label=f"grid optimum ({Zp[idx]:.1f} %)")
    ax.plot(6.44, 0.0, marker="o", ms=8, color="#1f77b4", markeredgecolor="w",
            label="REF (pKa 6.44, DSPC)")
    ax.plot(6.80, 1.0, marker="X", ms=11, color="#d62728", markeredgecolor="w",
            label="claimed 'EXTREME' corner (pKa 6.8, all-DOPE)")
    ax.text(6.80, 0.95, "dead zone", color="#d62728", fontsize=9, ha="center", fontweight="bold")
    ax.set_xlabel("apparent pKa of ionizable lipid")
    ax.set_ylabel("DOPE fraction of helper lipid  (0 = all DSPC, 1 = all DOPE)")
    ax.set_title("Design-plane net mRNA delivery (endosomal escape x ApoE/hepatic "
                 "uptake weight, NPC1 normal)\n"
                 "30 % is never reached; the advertised EXTREME corner is a dead zone",
                 fontsize=10)
    fig.colorbar(pc, ax=ax, label="net mRNA delivered  (%)")
    ax.legend(fontsize=8, loc="upper left")
    fig.tight_layout()
    p = str(Path(outdir) / "fig5_design_deadzone_map.png")
    fig.savefig(p, dpi=160, bbox_inches="tight"); plt.close(fig); return p

# ----------------------------------------------------------------------------
# 8. Main
# ----------------------------------------------------------------------------
def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else "."
    Path(outdir).mkdir(parents=True, exist_ok=True)
    print("=" * 78)
    print(" LNP ENDOSOMAL-ESCAPE THERMODYNAMICS / KINETIC RACE MODEL")
    print("=" * 78)

    # --- packing table ------------------------------------------------------
    geo = lipid_geometry_table()
    print("\n[1] Molecular packing parameter (E1)")
    print(f"{'lipid':6s} {'v (nm3)':>9s} {'a0 (nm2)':>9s} {'lc (nm)':>8s} {'S':>6s}  shape / phase tendency")
    for r in geo:
        tag = "cylinder -> L_a" if r["S"] <= 1.0 else "cone (S>1) -> H_II"
        print(f"{r['name']:6s} {r['v_nm3']:9.3f} {r['a0_nm2']:9.3f} {r['lc_nm']:8.3f} "
              f"{r['S']:6.3f}  {tag}")
    save_csv(os.path.join(outdir, "table_packing_parameter.csv"),
             [dict(r, shape="cylinder->L_a" if r["S"] <= 1.0 else "cone->H_II") for r in geo])

    # --- pH sweep -----------------------------------------------------------
    print("\n[2] pH sweep of curvature / driving force / barrier")
    phs_sweep = [7.4, 7.0, 6.6, 6.4, 6.2, 6.0, 5.7, 5.4, 5.0]
    rows = []
    for ph in phs_sweep:
        row = {"pH": ph}
        for tag, d in FORMULATIONS.items():
            z = zeta_core(ph, d["pKa"], d["phi"])
            D = bulk_driving_D(ph, d["pKa"], d["phi"])
            g = escape_barrier_kBT(z, 0.22)
            key = tag.split(" ")[0]
            row[f"{key}_alpha"] = round(alpha(ph, d["pKa"]), 3)
            row[f"{key}_zeta"] = round(z, 3)
            row[f"{key}_D_kBT"] = round(D, 0)
            row[f"{key}_dGesc"] = round(g, 2)
        rows.append(row)
    save_csv(os.path.join(outdir, "table_ph_sweep.csv"), rows)
    hdr = f"{'pH':>4s}"
    for tag, d in FORMULATIONS.items():
        k = tag.split(" ")[0]
        hdr += f"  {k:>6s} {'zeta':>6s} {'D':>7s} {'dG++':>6s}"
    print(hdr)
    for r in rows:
        line = f"{r['pH']:4.1f}"
        for tag, d in FORMULATIONS.items():
            k = tag.split(" ")[0]
            line += (f"  {r[f'{k}_alpha']:6.2f} {r[f'{k}_zeta']:6.2f} "
                     f"{r[f'{k}_D_kBT']:7.0f} {r[f'{k}_dGesc']:6.1f}")
        print(line)

    # --- characteristic pHs --------------------------------------------------
    print("\n[3] Characteristic pH values (misplaced-fusogenicity argument)")
    for tag, d in FORMULATIONS.items():
        po, pc = characteristic_pHs(d["pKa"], d["phi"])
        print(f"  {tag:26s}: fusion-min pH = {po if po else float('nan'):5.2f}  |  "
              f"internal-H_II collapse onset pH = {pc if pc else float('nan'):5.2f}")

    # --- end-of-run metrics --------------------------------------------------
    print("\n[4] End-of-run compartment metrics (120 min), by NPC1 level")
    met = []
    for tag, d in FORMULATIONS.items():
        for nlab, nv in NPC1_LEVELS.items():
            s = simulate(d["pKa"], d["phi"], nv)
            print(f"  {tag:28s} | {nlab:12s}: released={100*s['released']:5.3f}%  "
                  f"peak-collapsed={100*s['peak_collapsed']:4.1f}% @ t={s['t_peak_collapsed']:4.1f}min  "
                  f"lys.cargo={100*s['lysosomal']:5.1f}%  recycled={100*s['recycled']:5.1f}%")
            met.append(dict(formulation=tag, npc1=nlab, released_pct=100 * s["released"],
                            peak_collapsed_pct=100 * s["peak_collapsed"],
                            t_peak_collapsed_min=round(s["t_peak_collapsed"], 1),
                            lys_cargo_pct=100 * s["lysosomal"],
                            recycled_pct=100 * s["recycled"]))
    save_csv(os.path.join(outdir, "table_formulation_metrics.csv"), met)

    # --- design grid ---------------------------------------------------------
    print("\n[5] Design-space scan (pKa x DOPE-fraction), NPC1 normal; "
          "in-vivo map = endosomal escape x ApoE/hepatic-uptake(pKa) weight")
    X, Y, Z = release_efficiency_grid(weighted=True)
    Zp = Z * 100
    am = np.unravel_index(np.nanargmax(Zp), Zp.shape)
    print(f"  global maximum net delivery on grid = {Zp[am]:.2f} %  at pKa="
          f"{X[0, am[1]]:.2f}, phi_DOPE={Y[am[0], 0]:.2f}   (claimed >30 % is "
          "not reached anywhere)")
    ZE = release_efficiency_grid(weighted=False)[2]     # unweighted endosomal map
    pkax = np.arange(6.00, 7.21, 0.05); phix = np.arange(0.0, 1.001, 0.05)
    def z_at(pka, phi, grid):
        i = int(np.argmin(np.abs(phix - phi))); j = int(np.argmin(np.abs(pkax - pka)))
        return grid[i, j] * 100
    wref = uptake_weight(6.44); wext = uptake_weight(6.80)
    eref = z_at(6.44, 0.0, ZE); eext = z_at(6.80, 1.0, ZE)
    print(f"  REF  (pKa 6.44, DSPC):  endosomal escape={eref:.2f} %   "
          f"x uptake {wref:.2f}  -> net {eref * wref:.2f} %")
    print(f"  EXTREME (pKa 6.80, all-DOPE): endosomal escape={eext:.4f} %  "
          f"x uptake {wext:.2f}  -> net {eext * wext:.5f} %")
    for ph in (1.0, 0.8, 0.6, 0.4, 0.2):
        print(f"   pKa=6.8, phi_DOPE={ph:.1f}: endosomal {z_at(6.8, ph, ZE):.4f} %  "
              f"net {z_at(6.8, ph, ZE) * wext:.4f} %")

    # --- figures -------------------------------------------------------------
    print("\n[6] Writing figures ...")
    figs = [make_fig1(outdir), make_fig2(outdir), make_fig3(outdir),
            make_fig4(outdir), make_fig5(outdir, X, Y, Z)]
    for f in figs:
        print("   saved", f)
    print("\nDone.")
    return figs

if __name__ == "__main__":
    main()
