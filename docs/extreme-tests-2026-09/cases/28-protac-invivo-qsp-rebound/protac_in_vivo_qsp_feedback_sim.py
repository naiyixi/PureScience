#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
protac_in_vivo_qsp_feedback_sim.py
==================================
QSP adversarial review: does an ultra-potent oral PROTAC (DC50 ~50 pM,
Dmax ~98 %, in-vitro hook ~1 uM, QD dosing, plasma Cmax 5 uM / Cmin 0.27 uM)
really keep its target cleared around the clock in vivo, as the R&D claim
asserts ?

Model : multi-scale / multi-physics closed-loop ODE system
-----------------------------------------------------------
1) Two-compartment oral PK with first-order absorption (per-hour rates);
   the QD dose is auto-calibrated so that steady-state Cmax ~ 5 uM
   (Cmin ~ 0.27 uM, i.e. >5000x the DC50 - more favourable to the claim
   than their own 100 nM number).
2) PROTAC degradation is a *non-monotone* (bell-shaped) concentration-effect,
   lambda_deg(D) = Vmax * phi(D), with
       phi(D) = (D^h/(D^h+Km^h)) * (Ki^q/(Ki^q+D^q))
   the closed-form occupancy proxy of the two-site ternary-complex mass
   action (target-drug rising limb + E3-ligase sequestration / "Hook"
   falling limb).  The four constants are calibrated so the 24 h in-vitro
   dose-response reproduces the pipeline's own figures:
       DC50 ~ 50 pM, Dmax ~ 98 %, plateau kept to ~1 uM, near-total loss
       (Hook blackout) by Cmax = 5 uM  (lambda 5.8 /h at trough vs
       ~0.08 /h at Cmax => ~70x swing inside one dosing interval).
3) Transcriptional negative-feedback (auto-repressing oncogenic TF):
   target protein represses its own transcription; upon deep degradation the
   brake is removed and the mRNA-synthesis state rises toward its
   derepression capacity (T_base/Kauto)**n ~ 25x (10-50x range) through an
   mRNA intermediate of 2 h half-life (delayed / indirect response).
       dm/dt = k_dm*(mult(T)-m) ; mult(T) rises as T falls (Hill in T)
       dT/dt = k_b*T_base*m - k_b*T - lambda_deg(D)*T
4) Darwinian clone competition (logistic, shared carrying capacity):
       S  : drug-sensitive (parameters above)
       R1 : efflux-pump-upregulated clone (intracellular drug /30)
       R2 : CRBN/E3 hypomorphic clone (degradation ceiling Vmax*0.12)
   Cell net growth depends on the functional (driver) level A = T/T_base
   through a steep sigmoid death gate: A << 1 -> cell death (oncogene
   dependency), A ~ 1 -> proliferation, A > 1 (overshoot) -> extra growth.

Regimens compared over 6 weeks
   A QD-high  : QD dose giving Cmax 5 uM          (the R&D plan)
   B QD-low   : QD dose giving Cmax 0.5 uM  (below the Hook, trough 27 nM)
   C TID      : same daily dose as B split every 8 h (flat active window)
   Vehicle    : untreated reference

Outputs (default ./protac_qsp_out/)
   fig1_pk_doseresp_windows.png   in-vitro bell, phi occupancy, PK windows
   fig2_qd_oscillation_rebound.png 14-day QD-high target oscillation/rebound
   fig3_regimen_tumor_resistance.png  tumor volume & resistant fraction
   fig4_mechanism_dissection.png   overshoot attribution (feedback x hook)

Dependencies: numpy, scipy, matplotlib.
Run:  python protac_in_vivo_qsp_feedback_sim.py [--outdir DIR]
"""
from __future__ import annotations
import argparse, os, json
import numpy as np
from scipy.integrate import solve_ivp
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ----------------------------------------------------------------------
# Parameters (time in hours; concentrations in nM; cells in arbitrary units)
# ----------------------------------------------------------------------
P = dict(
    # --- target turnover -------------------------------------------------
    T_base=100.0,          # baseline target concentration (nM)
    k_b=0.0577,            # basal protein degradation /h  (t1/2 ~ 12 h)
    # --- empirical PROTAC bell (fitted to the pipeline in-vitro data) ----
    Vmax=6.0,              # max degradation rate /h at plateau
    Km=5.0, Ki=1200.0, h=1.0, q=3.0,   # DC50~50pM; Hook collapse >~1 uM
    # --- transcriptional negative-feedback loop --------------------------
    k_dm=np.log(2)/2.0,    # mRNA decay /h (2 h half-life -> response lag)
    Kauto=20.0,            # repressor set-point (nM); capacity ~(Tb/Kauto)^n
    n_hill=2.0,            # repressor Hill coefficient
    F=25.0,                # promoter maximal output (≳ capacity, not limiting)
    leak=0.02,             # leaky (repressed-floor) transcription
    FBON=True,             # transcription-feedback switch (False = no FB)
    # --- 2-compartment oral PK -------------------------------------------
    ka=1.2, k10=0.3, k12=1.2, k21=1.0, Vc=1.0,   # terminal t1/2 ~5.5 h
    # --- clonal competition (per h) --------------------------------------
    gmax=0.014, gA=0.30,           # proliferation saturating on A
    d_base=0.0015,                 # basal death
    d_supp=0.020, Asd=0.25, n_death=4.0,   # steep death when A<Asd
    Kcar=1e6,                      # shared carrying capacity (cells)
    N0=1e5,                        # initial tumor size
    Rfrac=1e-3,                    # pre-existing resistant fraction
)
KINDS = ["S", "R1", "R2"]

def clone_param(kind):
    """Per-clone: zeta = efflux fold-reduction of intracellular drug;
    Vmax = degradation ceiling (E3 catalytic capacity)."""
    return {"S":  dict(zeta=1.0,  Vmax=P["Vmax"]),
            "R1": dict(zeta=30.0, Vmax=P["Vmax"]),            # P-gp up
            "R2": dict(zeta=1.0,  Vmax=P["Vmax"]*0.12)}[kind] # E3/CRBN lesion

def mult_factor(T0, F):
    """Raw transcription multiplier before baseline normalisation."""
    T0 = np.clip(np.asarray(T0, float), 0.0, None)
    fb = P["Kauto"]**P["n_hill"] / (P["Kauto"]**P["n_hill"] + T0**P["n_hill"])
    return P["leak"] + (F - P["leak"]) * fb

# ----------------------------------------------------------------------
# PROTAC concentration-effect
# ----------------------------------------------------------------------
def phi_ternary(D, hook=True):
    """Degradation-competent ternary occupancy proxy in [0,1].
    Rising limb: target-drug binary formation.
    Falling limb (Hook): E3 sequestration into unproductive E3-drug binary.
    hook=False removes the falling limb (monotone control)."""
    D = np.clip(np.asarray(D, float), 0.0, None)
    rise = D**P["h"] / (D**P["h"] + P["Km"]**P["h"])
    if not hook:
        return rise
    fall = P["Ki"]**P["q"] / (P["Ki"]**P["q"] + D**P["q"])
    return rise * fall

def lambda_deg(D, Vmax, hook=True):
    return Vmax * phi_ternary(D, hook=hook)

def trans_mult(T0):
    """Transcription multiplier vs total target, normalised so that
    trans_mult(T_base)=1:
      1 at baseline; rises (derepression) as T falls below Kauto; falls to
      ~leak when T >> Kauto (self-repression that terminates an overshoot).
    With FBON=False it is identically 1 (constant transcription: the
    R&D team's implicit assumption, used as the no-feedback control)."""
    if not P.get("FBON", True):
        return np.ones_like(np.asarray(T0, float))
    return mult_factor(T0, P["F"]) / mult_factor(P["T_base"], P["F"])

# ----------------------------------------------------------------------
# ODE core
# ----------------------------------------------------------------------
def rhs(t, y):
    A0, Cc, Cp = y[0], y[1], y[2]
    d = [-P["ka"]*A0,
         P["ka"]*A0/P["Vc"] - (P["k10"]+P["k12"])*Cc + P["k21"]*Cp,
         P["k12"]*Cc - P["k21"]*Cp]
    Ntot = sum(y[3+3*k+2] for k in range(3))
    cap = max(1.0 - Ntot/P["Kcar"], 0.0)
    for k, kind in enumerate(KINDS):
        c = clone_param(kind)
        m, T0, N = y[3+3*k], y[3+3*k+1], y[3+3*k+2]
        D = max(Cc, 0.0)/c["zeta"]
        ld = lambda_deg(D, c["Vmax"])
        dm = P["k_dm"]*(trans_mult(T0) - m)
        dT = P["k_b"]*P["T_base"]*m - P["k_b"]*max(T0, 0.0) - ld*max(T0, 0.0)
        Aact = max(T0, 0.0)/P["T_base"]
        de = (P["d_base"] + P["d_supp"]*P["Asd"]**P["n_death"]
              / (P["Asd"]**P["n_death"] + Aact**P["n_death"]))
        net = P["gmax"]*Aact/(Aact+P["gA"]) - de
        d.append(dm); d.append(dT); d.append(N*net*cap)
    return np.asarray(d)

def y0_init():
    Ns = P["N0"]*(1 - 2*P["Rfrac"])          # per resistant clone Rfrac
    Nr = P["N0"]*P["Rfrac"]
    y = [0.0, 0.0, 0.0]
    for k in range(3):
        y += [1.0, P["T_base"], Ns if k == 0 else Nr]
    return np.asarray(y, float)

def run_regimen(events_h, dose_mass, days=14, hstep=0.1, tmax=None):
    """Piecewise integration; a dose is added to the depot at every event."""
    T_end = days*24.0 if tmax is None else tmax
    y = y0_init(); ts, Ys = [], []; cur = 0.0
    while cur < T_end - 1e-9:
        nxt = min(cur + events_h, T_end)
        y[0] += dose_mass
        te = np.linspace(cur, nxt, max(2, int(round((nxt-cur)/hstep)) + 1))
        sol = solve_ivp(rhs, [cur, nxt], y, t_eval=te, method="LSODA",
                        rtol=1e-6, atol=1e-9, max_step=0.25)
        y = np.maximum(sol.y[:, -1], 0.0).copy()
        ts.append(sol.t); Ys.append(sol.y); cur = nxt
    return np.concatenate(ts), np.concatenate(Ys, axis=1)

def postprocess(t, Y):
    o = dict(t=t, Cc=Y[1], phi=phi_ternary(Y[1]))
    for k, kind in enumerate(KINDS):
        o["m_" + kind], o["T_" + kind], o["N_" + kind] = \
            Y[3+3*k], Y[3+3*k+1], Y[3+3*k+2]
    # degradation-competent target complex (nM, sensitive clone)
    o["ternaryS"] = phi_ternary(Y[1]) * Y[3+1]
    return o

# ----------------------------------------------------------------------
# Dose calibration: pick QD dose so steady-state Cmax = 5000 nM
# ----------------------------------------------------------------------
def calibrate_dose(cmax_target=5000.0):
    t, Y = run_regimen(24.0, 1000.0, days=5, hstep=0.25, tmax=5*24)
    sel = t >= 4*24
    cmax_probe = Y[1][sel].max()
    return 1000.0*cmax_target/cmax_probe

# ----------------------------------------------------------------------
# Run the regimen set
# ----------------------------------------------------------------------
def run_all(days=42):
    dose_high = calibrate_dose()
    dose_low = dose_high/10.0
    arms = {
        "QD-high 5uM": dict(events=24.0, dose=dose_high, days=days),
        "QD-low 0.5uM": dict(events=24.0, dose=dose_low, days=days),
        "TID-sustain":  dict(events=8.0,  dose=dose_low/3.0, days=days),
        "Vehicle":      dict(events=24.0, dose=0.0, days=days),
    }
    res = {}
    for name, cfg in arms.items():
        t, Y = run_regimen(cfg["events"], cfg["dose"], days=cfg["days"],
                           hstep=0.2)
        res[name] = postprocess(t, Y)
    # long, fine-grained QD-high run for the 14-day oscillation figure
    t, Y = run_regimen(24.0, dose_high, days=14, hstep=0.05)
    res["_qd14"] = postprocess(t, Y)
    return res, dict(dose_high=dose_high, dose_low=dose_low)

def run_patched(F=None, FBON=True, Kauto=None, hook=True, events=24.0,
                dose=None, days=8):
    """Run QD-high with modified feedback (strength F / switch FBON /
    repressor set-point Kauto) and/or Hook; post-processes and restores
    globals afterwards.  trans_mult() normalises against current P so each
    control run is exact."""
    global phi_ternary
    saved = (P["F"], P["FBON"], P["Kauto"], phi_ternary)
    try:
        if F is not None:
            P["F"] = F
        P["FBON"] = FBON
        if Kauto is not None:
            P["Kauto"] = Kauto
        if not hook:
            _orig = phi_ternary
            def _no_hook(D, hook=True):
                return _orig(np.asarray(D, float), hook=False)
            phi_ternary = _no_hook
        t, Y = run_regimen(events, dose, days=days, hstep=0.1)
        return postprocess(t, Y)
    finally:
        P["F"], P["FBON"], P["Kauto"], phi_ternary = saved

# ----------------------------------------------------------------------
# Summary metrics
# ----------------------------------------------------------------------
def metrics(R, day14=14.0, day_end=None):
    Nt = R["N_S"] + R["N_R1"] + R["N_R2"]
    fR = (R["N_R1"] + R["N_R2"])/np.maximum(Nt, 1.0)
    i14 = R["t"] <= day14*24
    m = (R["t"] >= 24) & i14 & (R["N_S"] > 1)
    As = R["T_S"][m]/P["T_base"]
    over = np.trapezoid(np.clip(As - 1.0, 0, None), R["t"][m])/24.0
    out = dict(V14=float(Nt[i14][-1]), fR14=float(fR[i14][-1]),
               meanA=float(np.mean(As)) if m.any() else np.nan,
               maxA=float(np.max(As)) if m.any() else np.nan,
               overshoot_d=over,
               TminS=float(np.min(R["T_S"][m])) if m.any() else np.nan,
               TmaxS=float(np.max(R["T_S"][m])) if m.any() else np.nan)
    if day_end is not None:
        iE = R["t"] <= day_end*24
        out["Vend"] = float(Nt[iE][-1])
        out["fRend"] = float(fR[iE][-1])
    return out

def print_summary(res, day_end=42.0):
    hdr = (f"\n{'arm':<14s} {'V@d14':>10s} {'V@d42':>10s} {'fR@d42':>8s} "
           f"{'<A_S>':>7s} {'maxA_S':>7s} {'overshAUCd':>9s} "
           f"{'T_S range':>16s}")
    print(hdr); print("-"*len(hdr))
    rows = {}
    for name, R in res.items():
        if name.startswith("_"):
            continue
        mm = metrics(R, day_end=day_end)
        rows[name] = mm
        print(f"{name:<14s} {mm['V14']:10.0f} {mm.get('Vend',0):10.0f} "
              f"{mm.get('fRend',0)*100:7.1f}% {mm['meanA']:7.3f} "
              f"{mm['maxA']:7.3f} {mm['overshoot_d']:9.3f} "
              f"[{mm['TminS']:6.1f},{mm['TmaxS']:6.1f}]")
    return rows

# ----------------------------------------------------------------------
# Figure helpers
# ----------------------------------------------------------------------
def decimate(t, x, step=2):
    return t[::step], x[::step]

BLUE, ORANGE, GREEN, RED, GREY, PURPLE = (
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#7f7f7f", "#9467bd")

def fig1_invitro_pk_windows(res, outdir):
    """(a) in-vitro 24 h dose-response of the bell; (b) phi occupancy with
    operating points; (c) steady-day plasma profiles for the 3 regimens."""
    fig, ax = plt.subplots(1, 3, figsize=(15.5, 4.6))
    # (a) in-vitro response ------------------------------------------------
    D = np.logspace(-2, 3.9, 160)
    rem = np.empty_like(D)
    for i, Dv in enumerate(D):
        T0, ksyn = P["T_base"], P["k_b"]*P["T_base"]
        def f(_t, y):
            T = max(y[0], 0.0)
            return [ksyn - P["k_b"]*T - lambda_deg(Dv, P["Vmax"])*T]
        sol = solve_ivp(f, [0, 24], [T0], method="LSODA", rtol=1e-7, atol=1e-9)
        rem[i] = sol.y[0, -1]/T0*100
    a = ax[0]
    a.semilogx(D, rem, color=BLUE, lw=2)
    a.axhline(50, color=GREY, ls=":", lw=1)
    a.axvline(0.05, color=GREEN, ls="--", lw=1.2)
    a.text(0.06, 82, "DC$_{50}$ ≈ 0.05 nM", color=GREEN, fontsize=9)
    a.axvspan(1e3, 8e3, color=RED, alpha=0.12)
    a.text(1.5e3, 95, "Hook\nregion", color=RED, fontsize=9)
    a.set_xlabel("drug concentration (nM)"); a.set_ylabel("target remaining, 24 h (%)")
    a.set_title("(a) In-vitro dose-response of λ$_{deg}$ bell\n"
                "(DC$_{50}$≈0.05 nM · D$_{max}$≈98 % · plateau→~1 µM)")
    a.set_ylim(0, 105); a.grid(alpha=0.25)
    # (b) phi occupancy + operating points --------------------------------
    b = ax[1]
    ph = phi_ternary(D)
    b.semilogx(D, ph, color=PURPLE, lw=2)
    b.set_xlabel("drug concentration (nM)"); b.set_ylabel("φ(D): ternary occupancy proxy")
    b.axvspan(1000, 8000, color=RED, alpha=0.12)
    for xv, lab, col in [(0.05, "DC50", GREEN), (270, "C$_{min}$", BLUE),
                         (5000, "C$_{max}$", RED)]:
        b.plot(xv, phi_ternary(xv), "o", color=col, ms=7)
        b.annotate(lab, (xv, phi_ternary(xv)), textcoords="offset points",
                   xytext=(6, 8), color=col, fontsize=9)
    b.axhline(0.5, color=GREY, ls=":", lw=1)
    b.set_title("(b) Ternary occupancy φ(D) with QD operating points\n"
                "trough on the plateau (φ≈0.97) · C$_{max}$ in the Hook (φ≈0.01)")
    b.grid(alpha=0.25)
    # (c) steady-day PK profiles ------------------------------------------
    c = ax[2]
    c.axhspan(0.02e3, 1.0e3, color=GREEN, alpha=0.08)
    c.text(1.0, 3.0e2, "active plateau window\n(≈0.02–1 µM)", color=GREEN, fontsize=8)
    c.axhspan(1.0e3, 8e3, color=RED, alpha=0.10)
    for name, col, ls in [("QD-high 5uM", RED, "-"),
                          ("QD-low 0.5uM", BLUE, "-"),
                          ("TID-sustain", ORANGE, "--")]:
        R = res[name]
        t = R["t"]; Tlast = t[-1]
        w = (t >= Tlast-24) & (t <= Tlast)     # last steady 24 h
        c.semilogy((t[w]-Tlast+24)/24.0, R["Cc"][w], color=col, ls=ls, lw=1.8,
                   label=name)
    c.axhline(0.05, color=GREEN, ls=":", lw=1)
    c.text(0.2, 0.06, "DC50=0.05 nM", color=GREEN, fontsize=8)
    c.set_xlabel("time after dose (h)"); c.set_ylabel("plasma conc (nM)")
    c.set_title("(c) Steady-state plasma profiles (log) vs active window")
    c.legend(fontsize=8, loc="upper right"); c.grid(alpha=0.25, which="both")
    fig.tight_layout()
    p = os.path.join(outdir, "fig1_pk_doseresp_windows.png")
    fig.savefig(p, dpi=170); plt.close(fig)
    return p

def fig2_oscillation_rebound(res, outdir):
    """14-day QD-high: plasma, active ternary, target-oscillation/rebound
    with mRNA derepression state."""
    R = res["_qd14"]
    fig, ax = plt.subplots(3, 1, figsize=(11.5, 9.2), sharex=True)
    t = R["t"]/24.0
    # row 1 plasma
    a = ax[0]
    a.semilogy(t, R["Cc"], color=RED, lw=1.1)
    a.axhline(1e3, color=RED, ls="--", lw=0.9)
    a.axhline(0.05, color=GREEN, ls=":", lw=0.9)
    a.text(1.0, 3.5e3, "Hook / near-blackout (φ<0.2, λ≤1.2/h)", color=RED,
           fontsize=8.5)
    a.text(1.0, 0.5, "DC50", color=GREEN, fontsize=8)
    a.set_ylabel("plasma C$_p$ (nM)")
    a.set_title("14-day QD dosing (5 µM C$_{max}$, 0.27 µM C$_{min}$): "
                "PK → ternary → target rebound (sensitive clone)")
    a.grid(alpha=0.25, which="both")
    # row 2 ternary proxy
    b = ax[1]
    b.plot(t, R["phi"], color=PURPLE, lw=0.9)
    b.axhline(0.2, color=GREY, ls=":", lw=0.8)
    b.set_ylabel("φ (ternary occupancy)\nactive ternary φ·T$_{0}$ shown")
    b2 = b.twinx()
    b2.plot(t, R["ternaryS"], color=ORANGE, lw=1.0)
    b2.set_ylabel("φ·T$_0$ (nM)", color=ORANGE)
    b2.tick_params(axis="y", colors=ORANGE)
    b.grid(alpha=0.25)
    b.fill_between(t, R["phi"], 0, where=R["phi"] < 0.2, color=RED, alpha=0.15)
    # row 3 target + mRNA
    c = ax[2]
    As = R["T_S"]/P["T_base"]
    c.plot(t, As, color=BLUE, lw=1.3, label="target A = T$_0$/T$_{base}$")
    c.axhline(1.0, color=GREY, ls="--", lw=1)
    c.text(0.2, 1.55, "overshoot above baseline (A>1): therapy-opposite "
           "target accumulation", color=RED, fontsize=8.5)
    c.fill_between(t, As, 1.0, where=As > 1.0, color=RED, alpha=0.35)
    c.set_ylabel("T$_0$/T$_{base}$")
    c2 = c.twinx()
    c2.plot(t, R["m_S"], color=GREEN, lw=1.1, ls="--",
            label="mRNA derepression state m")
    c2.set_ylabel("m (×baseline)", color=GREEN)
    c2.tick_params(axis="y", colors=GREEN)
    c.set_xlabel("time (days)")
    c.set_ylim(0, 2.0)
    c.grid(alpha=0.25)
    h1, l1 = c.get_legend_handles_labels(); h2, l2 = c2.get_legend_handles_labels()
    c.legend(h1+h2, l1+l2, fontsize=8, loc="upper right", framealpha=0.9)
    fig.tight_layout()
    p = os.path.join(outdir, "fig2_qd_oscillation_rebound.png")
    fig.savefig(p, dpi=170); plt.close(fig)
    return p

def fig3_tumor_resistance(res, outdir, day_end=42.0):
    names = ["Vehicle", "QD-high 5uM", "QD-low 0.5uM", "TID-sustain"]
    cols = [GREY, RED, BLUE, ORANGE]
    fig, ax = plt.subplots(1, 3, figsize=(16, 4.8))
    # (a) total tumor volume
    a = ax[0]
    for name, col in zip(names, cols):
        R = res[name]; Nt = R["N_S"]+R["N_R1"]+R["N_R2"]
        m = R["t"] <= day_end*24
        a.semilogy(R["t"][m]/24, Nt[m], color=col, lw=2.0, label=name)
    a.axvline(14, color=GREY, ls=":", lw=1)
    a.text(14.2, 3e5, "day 14", fontsize=8, color=GREY)
    a.set_xlabel("time (days)"); a.set_ylabel("total tumor cells")
    a.set_title("(a) Total tumor burden (log)")
    a.legend(fontsize=8); a.grid(alpha=0.25, which="both")
    a.set_ylim(1e1, 2e6)
    # (b) resistant fraction
    b = ax[1]
    for name, col in zip(["QD-high 5uM", "QD-low 0.5uM", "TID-sustain"], [RED, BLUE, ORANGE]):
        R = res[name]; Nt = R["N_S"]+R["N_R1"]+R["N_R2"]
        fR = 100*(R["N_R1"]+R["N_R2"])/np.maximum(Nt, 1.0)
        m = R["t"] <= day_end*24
        b.plot(R["t"][m]/24, fR[m], color=col, lw=2.0,
               label=name + (" (E3-lesion R2)" if "QD-high" in name else ""))
    b.set_xlabel("time (days)"); b.set_ylabel("resistant fraction (%)")
    b.set_title("(b) Resistant-clone dominance")
    b.legend(fontsize=8); b.grid(alpha=0.25)
    # (c) sensitive vs E3-lesion clone for QD-high and QD-low
    c = ax[2]
    for name, col in zip(["QD-high 5uM", "QD-low 0.5uM"], [RED, BLUE]):
        R = res[name]; m = R["t"] <= day_end*24
        c.semilogy(R["t"][m]/24, R["N_S"][m], color=col, ls="-", lw=1.7)
        c.semilogy(R["t"][m]/24, R["N_R2"][m], color=col, ls="--", lw=1.7)
    c.plot([], [], color="k", ls="-", label="sensitive S")
    c.plot([], [], color="k", ls="--", label="E3-lesion R2")
    c.set_xlabel("time (days)"); c.set_ylabel("clone cell number")
    c.set_title("(c) S vs E3-lesion R2 (— S, ‥ R2)")
    c.legend(fontsize=8); c.grid(alpha=0.25, which="both")
    c.set_ylim(1e0, 1e6)
    fig.tight_layout()
    p = os.path.join(outdir, "fig3_regimen_tumor_resistance.png")
    fig.savefig(p, dpi=170); plt.close(fig)
    return p

def fig4_mechanism_dissection(res_diss, qdlow, outdir):
    """Same QD-high dose; toggle feedback (F) or Hook -> overshoot requires
    BOTH. Compare with QD-low (no Hook excursion)."""
    Rhi = res_diss["full"]
    fig, ax = plt.subplots(1, 2, figsize=(14.5, 4.6))
    t0, t1 = 10*24, 14*24
    m = (Rhi["t"] >= t0) & (Rhi["t"] <= t1)
    a = ax[0]
    for key, lab, col in [("full", "QD-high 5 µM (F=25, Hook on)", RED),
                          ("noFb", "QD-high, no feedback (F=1)", GREY),
                          ("noHook", "QD-high, no Hook (monotone)", GREEN)]:
        R = res_diss[key]
        mm = (R["t"] >= t0) & (R["t"] <= t1)
        a.plot((R["t"][mm]-t0)/24, R["T_S"][mm]/P["T_base"], color=col,
               lw=1.4, label=lab)
    mm = (qdlow["t"] >= t0) & (qdlow["t"] <= t1)
    a.plot((qdlow["t"][mm]-t0)/24, qdlow["T_S"][mm]/P["T_base"], color=BLUE,
           lw=1.2, ls="--", label="QD-low 0.5 µM (avoids Hook)")
    a.axhline(1.0, color=GREY, ls=":", lw=1)
    a.text(3.9, 1.62, "rebound overshoot\n(needs feedback × Hook)",
           color=RED, fontsize=9)
    a.set_xlabel("time in day 10–14 (h)"); a.set_ylabel("A = T$_0$/T$_{base}$")
    a.set_title("(a) Which mechanism makes the rebound?\n"
                "removing EITHER feedback or Hook restores deep suppression")
    a.legend(fontsize=8, loc="upper right"); a.grid(alpha=0.25)
    # (b) summary bars
    b = ax[1]
    keys = ["QD-high 5µM", "QD-high no-Fb", "QD-high no-Hook", "QD-low 0.5µM"]
    R2 = [res_diss["full"], res_diss["noFb"], res_diss["noHook"], qdlow]
    mm_, meanA, maxA = [], [], []
    for R in R2:
        mm_ = (R["t"] >= 5*24) & (R["t"] <= 8*24)
        As = R["T_S"][mm_]/P["T_base"]
        meanA.append(np.mean(As)); maxA.append(np.max(As))
    xpos = np.arange(4)
    b.bar(xpos-0.19, meanA, 0.38, label="mean A (d5–8)", color="#9ecae1")
    b.bar(xpos+0.19, maxA, 0.38, label="max A (d5–8)", color="#3182bd")
    b.axhline(1.0, color=GREY, ls=":", lw=1)
    b.set_xticks(xpos); b.set_xticklabels(keys, fontsize=8)
    b.set_ylabel("target activity A")
    b.set_title("(b) Steady-day suppression & overshoot ceiling")
    b.legend(fontsize=8); b.grid(alpha=0.25, axis="y")
    fig.tight_layout()
    p = os.path.join(outdir, "fig4_mechanism_dissection.png")
    fig.savefig(p, dpi=170); plt.close(fig)
    return p

# ----------------------------------------------------------------------
# main
# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default="protac_qsp_out")
    ap.add_argument("--days", type=float, default=42.0)
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)
    print("calibrating QD dose to steady-state Cmax = 5 uM ...")
    res, doses = run_all(days=int(args.days))
    print(f"dose_high = {doses['dose_high']:.0f} (Cmax 5 uM) ; "
          f"dose_low = {doses['dose_low']:.0f}")
    # verify PK claims
    R = res["QD-high 5uM"]; w = R["t"] >= (R["t"][-1]-24)
    print(f"steady QD-high: Cmax={R['Cc'][w].max():.0f} nM, "
          f"Cmin={R['Cc'][w].min():.0f} nM")
    print_summary(res, day_end=float(args.days))

    # sensitivity of overshoot amplitude to feedback capacity
    # capacity ~ (T_base/Kauto)**n; FBON=False = constant transcription
    print("\nsensitivity of overshoot amplitude to feedback (QD-high, "
          "days 5-8 steady):")
    for label, kw in [("no feedback (FB off)", dict(FBON=False, Kauto=20.0)),
                      ("capacity ~5x (Kauto=50)", dict(FBON=True, Kauto=50.0)),
                      ("capacity ~12x (Kauto=30)", dict(FBON=True, Kauto=30.0)),
                      ("capacity ~25x (Kauto=20)", dict(FBON=True, Kauto=20.0))]:
        Rd = run_patched(F=25.0, hook=True, dose=doses["dose_high"], days=8,
                         **kw)
        s = (Rd["t"] >= 5*24) & (Rd["t"] <= 8*24)
        As = Rd["T_S"][s]/P["T_base"]
        print(f"  {label:<24s}: mean A={np.mean(As):.3f}  "
              f"max A={np.max(As):.3f}")

    # dissection runs (same QD-high dose; toggle feedback or Hook)
    diss = {}
    diss["full"]   = run_patched(F=25.0, FBON=True, hook=True,
                                 dose=doses["dose_high"], days=8)
    diss["noFb"]   = run_patched(F=25.0, FBON=False, hook=True,
                                 dose=doses["dose_high"], days=8)
    diss["noHook"] = run_patched(F=25.0, FBON=True, hook=False,
                                 dose=doses["dose_high"], days=8)

    print("\ngenerating figures ...")
    p1 = fig1_invitro_pk_windows(res, args.outdir)
    p2 = fig2_oscillation_rebound(res, args.outdir)
    p3 = fig3_tumor_resistance(res, args.outdir, day_end=float(args.days))
    p4 = fig4_mechanism_dissection(diss, res["QD-low 0.5uM"], args.outdir)
    print("saved:\n  " + "\n  ".join([p1, p2, p3, p4]))
    # machine-readable summary for the report
    summ = {"arms": {}}
    for name, R in res.items():
        if name.startswith("_"):
            continue
        summ["arms"][name] = metrics(R, day_end=float(args.days))
    summ["dose_high"] = doses["dose_high"]
    with open(os.path.join(args.outdir, "summary.json"), "w") as f:
        json.dump(summ, f, indent=1, default=float)
    return p1, p2, p3, p4

if __name__ == "__main__":
    main()
