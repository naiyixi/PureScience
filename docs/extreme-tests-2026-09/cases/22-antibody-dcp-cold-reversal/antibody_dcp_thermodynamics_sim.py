# -*- coding: utf-8 -*-
"""
antibody_dcp_thermodynamics_sim.py
===================================
Antibody-engineering "heat-capacity jump" (DeltaCp != 0) blind spot and
interfacial structured-water dynamical fragility: full-temperature simulation.

mAb-01 claim under attack
  Kd(25 C) = 5 pM  =>  DeltaG(25 C) = R*T*ln(Kd) ~ -15.4 kcal/mol
  DeltaH(25 C) = -35 kcal/mol  (strongly exothermic)
  "Van't Hoff: cooling only strengthens binding; an ultra-low Kd proves it can
   never be displaced in vivo."

Model layers
  L1  two-state binding with NON-ZERO, window-constant DeltaCp:
        DeltaH(T)=DeltaH0 + DeltaCp*(T - T0)
        DeltaS(T)=DeltaS0 + DeltaCp*ln(T / T0)
      exact differential  d(ln Kd)/dT = -DeltaH/(R T^2)
        => affinity extremum (min Kd) at T_H where DeltaH = 0
        => stability extremum (min DeltaG) at T_S where DeltaS = 0
  L2  naive constant-DeltaH Van't Hoff extrapolation vs L1 truth (deviation,
      expressed in log10 of the Kd ratio; grows with |DeltaCp| and |T - T0|).
  L3  effective cold penalty on top of L1:
        (a) local CDR/epitope cold-fold gate   -> f_active(T)
        (b) interfacial structured-water "fragility" term -> exp(Gw(T)/RT)
      together they turn the 2-8 C cold-storage zone into an effective-Kd
      reversal band ("cold inactivation latency region").
  L4  competitive target occupancy by mass action, incl. soluble decoy sinks.
  L5  residence-time model: intrinsic Arrhenius k_off vs ensemble apparent
      k_off once a cold-perturbed, fast-dissociating subpopulation appears.

Outputs (PNG @150 dpi, written to the working directory)
  fig1_thermo_decomposition.png   DeltaG / DeltaH / -T DeltaS vs T (T_H, T_S)
  fig2_vantoff_deviation.png      ln Kd vs 1/T real vs linear + Delta log10 Kd
  fig3_affinity_phase.png         affinity-response/reversal phase diagram
  fig4_occupancy_avalanche.png    target occupancy vs T + avalanche sensitivity
  fig5_water_koff.png             effective-Kd cold reversal + residence time
  sim_summary.txt                 machine-readable numeric digest

Run:   python antibody_dcp_thermodynamics_sim.py
No external dependencies beyond numpy / scipy / matplotlib.
"""

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap, BoundaryNorm

# ------------------------------------------------------------------ constants
R    = 1.987        # cal/(mol*K)
C2K  = 273.15
T0   = 298.15       # 25 C

Kd_ref = 5.0e-12           # M   (mAb-01 headline number)
dH_ref = -35000.0          # cal/mol
dG_ref = R*T0*np.log(Kd_ref)
dS_ref = (dH_ref - dG_ref)/T0        # ~ -65.7 cal/(mol*K)

CANON   = -800.0           # canonical DeltaCp (cal/(mol*K))
DC_LIST = [-300.0, -500.0, -800.0, -1500.0, -2300.0]
PAL = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#56B4E9", "#E69F00", "#111111"]

plt.rcParams.update({
    "font.size": 10.5, "axes.titlesize": 11.5, "axes.labelsize": 11,
    "xtick.direction": "in", "ytick.direction": "in",
    "axes.spines.top": False, "axes.spines.right": False,
    "figure.dpi": 150, "savefig.dpi": 150, "savefig.bbox": "tight",
    "legend.frameon": False, "axes.grid": True, "grid.alpha": 0.25,
})

# --------------------------------------------------------------- L1 two-state
def dH_T(Tc, dCp=CANON):
    T = Tc + C2K
    return dH_ref + dCp*(T - T0)                       # cal/mol

def dS_T(Tc, dCp=CANON):
    T = Tc + C2K
    return dS_ref + dCp*np.log(T/T0)                   # cal/(mol*K)

def dG_T(Tc, dCp=CANON):
    T = Tc + C2K
    return dH_T(Tc, dCp) - T*dS_T(Tc, dCp)             # cal/mol

def Kd_2s(Tc, dCp=CANON):
    T = Tc + C2K
    return np.exp(dG_T(Tc, dCp)/(R*T))                 # M

def T_H_c(dCp=CANON):       # DeltaH = 0  -> affinity extremum (min Kd)
    return T0 - dH_ref/dCp - C2K

def T_S_c(dCp=CANON):       # DeltaS = 0  -> DeltaG minimum
    return T0*np.exp(-dS_ref/dCp) - C2K

def Kd_naive(Tc):           # L2: constant-DeltaH linear Van't Hoff
    T = Tc + C2K
    return Kd_ref*np.exp((dH_ref/R)*(1.0/T - 1.0/T0))

# ------------------------------------------------------------ L3 cold effects
# Local stability of the engineered hot-spot (active vs inactive conformer):
#   G_act(T) = A + B*(T-T0) + Ck*[(T-T0) - T*ln(T/T0)]   [cal/mol]
# anchors: active form stable by 2.5 kcal @25 C, neutral (f=0.5) @4 C,
#          stable by 3.0 kcal @37 C.
GA, GB, GCK = -2500.0, -69.1, -1383.4

def G_act(Tc):
    T = Tc + C2K
    return GA + GB*(T - T0) + GCK*((T - T0) - T*np.log(T/T0))

def f_active(Tc):
    T = Tc + C2K
    return 1.0/(1.0 + np.exp(np.clip(G_act(Tc), -3.0e4, 3.0e4)/(R*T)))

def Gw(Tc, amp, Tg=10.0, wg=3.0):     # water-fragility penalty (cal/mol)
    return amp/(1.0 + np.exp((Tc - Tg)/wg))

def Kd_eff(Tc, dCp=CANON, amp=0.0):   # effective (apparent) Kd, M
    T = Tc + C2K
    Kd = Kd_2s(Tc, dCp)
    if amp > 0:
        Kd = Kd*np.exp(Gw(Tc, amp)/(R*T))
    return Kd/f_active(Tc)

# ---------------------------------------------------------- L4 target binding
def theta_target(Tc, Kd_fn, Atot, Ttot, decoys=()):
    """Mass-action competitive occupancy of target.
    decoys: iterable of (concentration, Kd). Returns theta, [Ab], Kd1."""
    Kd1 = float(Kd_fn(Tc))
    def g(A):
        return A + Ttot*A/(A + Kd1) + sum(c*A/(A + Kd) for c, Kd in decoys) - Atot
    lo, hi = 0.0, Atot
    for _ in range(300):
        mid = 0.5*(lo + hi)
        if g(mid) > 0:
            hi = mid
        else:
            lo = mid
    A = 0.5*(lo + hi)
    return A/(A + Kd1), A, Kd1

# ---------------------------------------------------------- L5 kinetics
KB, HP = 1.380649e-23, 6.62607015e-34

def koff_intrinsic(Tc, Ea=15000.0, k37=2.3e-5):
    T = Tc + C2K
    return k37*np.exp((-Ea/R)*(1.0/T - 1.0/310.15))    # s^-1

def phi_cold(Tc, Tg=7.0, w=2.5):                       # cold-perturbed fraction
    return 1.0/(1.0 + np.exp((Tc - Tg)/w))

def koff_apparent(Tc, ratio=50.0, Ea=15000.0):
    kint = koff_intrinsic(Tc, Ea)
    ph = phi_cold(Tc)
    return ((1.0 - ph) + ph*ratio)*kint

# ------------------------------------------------------------ printed digest
def dCp_asa_band(Anp, Apol):
    """ASA correlation for DeltaCp of burial (Anp, Apol in Angstrom^2).
    Nonpolar burial lowers Cp by c_np in [0.32, 0.50] cal/(K A^2);
    polar burial adds c_pol in [0.05, 0.30] cal/(K A^2)."""
    lo = -0.50*Anp + 0.05*Apol
    hi = -0.32*Anp + 0.30*Apol
    return lo, hi

def summary():
    L = []
    ap = L.append
    ap("=== mAb-01 anchor @25C: Kd=%.2e M -> dG=%.3f kcal/mol; dH=%.3f; dS=%.2f cal/(mol*K) ==="
       % (Kd_ref, dG_ref/1000.0, dH_ref/1000.0, dS_ref))
    ap("")
    ap("L1 two-state non-zero DeltaCp:")
    for dCp in DC_LIST:
        ap("  dCp=%7.0f cal/(mol*K): T_H=%6.2f C  T_S=%6.2f C | Kd@0C=%.3e  Kd@4C=%.3e  "
           "Kd@25C=%.3e  Kd@37C=%.3e" % (dCp, T_H_c(dCp), T_S_c(dCp),
           Kd_2s(0, dCp), Kd_2s(4, dCp), Kd_2s(25, dCp), Kd_2s(37, dCp)))
    ap("")
    ap("L2 naive constant-dH Van't Hoff vs real (log10 Kd_real/Kd_naive):")
    for dCp in DC_LIST:
        for Tc in (0, 4, 25, 37):
            dv = np.log10(Kd_2s(Tc, dCp)/Kd_naive(Tc))
            ap("  dCp=%6.0f: dlog10Kd(%2d C) = %+.3f" % (dCp, Tc, dv))
    ap("")
    ap("L3 effective cold reversal (dCp=CANON, water-fragility amp sweep, cold gate on):")
    for amp in (0.0, 2500.0, 5000.0, 9000.0):
        ap("  amp=%5.0f cal: Kd_eff@0C=%.3e  @4C=%.3e  @10C=%.3e  @25C=%.3e  @37C=%.3e"
           % (amp, Kd_eff(0, amp=amp), Kd_eff(4, amp=amp), Kd_eff(10, amp=amp),
              Kd_eff(25, amp=amp), Kd_eff(37, amp=amp)))
    ap("")
    ap("L5 kinetics: k_off_int(4/25/37 C) = %.2e / %.2e / %.2e s-1"
       % (koff_intrinsic(4), koff_intrinsic(25), koff_intrinsic(37)))
    for Tc in (4, 25, 37):
        ap("   phi_cold(%d C)=%.3f   k_off_app(%d C)=%.3e s-1   tau_app=%.2f h"
           % (Tc, phi_cold(Tc), Tc, koff_apparent(Tc), 1.0/koff_apparent(Tc)/3600.0))
    ap("")
    ap("ASA-based DeltaCp estimate for buried nonpolar/polar area:")
    for Anp, Apol in ((600, 400), (900, 600), (1200, 800), (1600, 1000)):
        lo, hi = dCp_asa_band(Anp, Apol)
        ap("  Anp=%5d A2, Apol=%5d A2 -> dCp in [%+.3f, %+.3f] kcal/(mol*K)"
           % (Anp, Apol, lo/1000.0, hi/1000.0))
    txt = "\n".join(L)
    print(txt)
    with open("sim_summary.txt", "w") as f:
        f.write(txt + "\n")
    return txt

# ------------------------------------------------------------------ figures
def fig1(Tc=None, dCp=CANON):
    if Tc is None:
        Tc = np.linspace(-45.0, 75.0, 601)
    dH = dH_T(Tc, dCp)/1000.0
    dS = dS_T(Tc, dCp)
    Tk = Tc + C2K
    mTS = -(Tk*dS)/1000.0
    dG = dG_T(Tc, dCp)/1000.0
    TH, TS = T_H_c(dCp), T_S_c(dCp)
    fig, ax = plt.subplots(figsize=(8.4, 5.4))
    ax.axvspan(0, 50, color="#EDEDED", zorder=0)
    ax.axhline(0, color="0.45", lw=1, zorder=1)
    ax.plot(Tc, dH, color=PAL[0], lw=2, label="DeltaH(T)  (real, DeltaCp<0)")
    ax.plot(Tc, mTS, color=PAL[1], lw=2, label="-T DeltaS(T)")
    ax.plot(Tc, dG, color=PAL[2], lw=2.6, label="DeltaG(T)")
    ax.plot(Tc, np.full_like(Tc, dH_ref/1000.0), ls=":", lw=1.8, color=PAL[3],
            label="DeltaH const. (naive assumption)")
    ax.axvline(TH, color=PAL[4], ls="--", lw=1.4)
    ax.axvline(TS, color=PAL[5], ls="--", lw=1.4)
    ax.plot([TH], [0.0], "o", ms=7, color=PAL[4], zorder=5)
    ax.plot([TS], [dG_T(TS, dCp)/1000.0], "o", ms=8, color=PAL[5], zorder=5)
    ax.annotate("T_H: DeltaH = 0\n(affinity extremum, min Kd)",
                xy=(TH, 0.0), xytext=(TH-9, 6),
                arrowprops=dict(arrowstyle="->", color="0.2"), fontsize=9.5)
    ax.annotate("T_S: DeltaS = 0\n(DeltaG minimum)",
                xy=(TS, dG_T(TS, dCp)/1000.0), xytext=(TS+4, -20),
                arrowprops=dict(arrowstyle="->", color="0.2"), fontsize=9.5)
    ax.text(25, 2.2, "physiological /\naqueous window", ha="center",
            fontsize=9, color="#444444")
    ax2 = ax.twinx()
    ax2.plot(Tc, np.log10(Kd_2s(Tc, dCp)), color="0.35", lw=1.4, ls="-.", alpha=0.9,
             label="log10(Kd) / M (right axis)")
    ax2.set_ylabel("log10(Kd) / M", color="0.2", fontsize=10)
    ax2.spines["right"].set_visible(False)
    ax2.tick_params(axis="y", colors="0.2")
    ax2.set_ylim(-15, -8)
    ax.set_xlabel("Temperature / C")
    ax.set_ylabel("Enthalpy-entropy terms / kcal mol-1")
    ax.set_xlim(-45, 75)
    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, loc="lower left", fontsize=8.4, ncol=2)
    fig.tight_layout()
    fig.savefig("fig1_thermo_decomposition.png")
    plt.close(fig)
    return TH, TS

def fig2():
    Tc = np.linspace(0.0, 50.0, 401)
    Tk = Tc + C2K
    fig, axes = plt.subplots(1, 2, figsize=(11.2, 4.2))
    ax = axes[0]
    ax.plot(1000.0/Tk, np.log(Kd_2s(Tc, CANON)), color=PAL[0], lw=2.4,
            label="real: non-zero DeltaCp")
    ax.plot(1000.0/Tk, np.log(Kd_naive(Tc)), color=PAL[1], lw=2.0, ls="--",
            label="naive: constant DeltaH")
    ax.plot([1000.0/T0], [np.log(Kd_ref)], "s", color="0.2", ms=7,
            label="anchor @25 C, 5 pM")
    ax.text(0.045, 0.06, "hotter", transform=ax.transAxes, fontsize=9, color="#444444")
    ax.text(0.90, 0.06, "colder", transform=ax.transAxes, fontsize=9, color="#444444")
    ax.set_xlabel("1000/T  /  K-1")
    ax.set_ylabel("ln Kd")
    ax.set_title("Van't Hoff: linear myth vs curved reality")
    ax.legend(fontsize=9, loc="lower right")
    ax2 = axes[1]
    for i, dCp in enumerate(DC_LIST):
        dv = np.log10(Kd_2s(Tc, dCp)/Kd_naive(Tc))
        ax2.plot(Tc, dv, color=PAL[i], lw=2.0,
                 label="DeltaCp = %+.0f cal mol-1 K-1" % dCp)
    ax2.axhline(0, color="0.5", lw=1)
    ax2.axvspan(30, 42, color="#EDEDED")
    ax2.text(36, -0.18, "in vivo", ha="center", fontsize=8, color="#555555")
    ax2.set_xlabel("Temperature / C")
    ax2.set_ylabel("log10(Kd_real / Kd_naive)")
    ax2.set_title("Divergence from constant-DeltaH extrapolation")
    ax2.legend(fontsize=8.5)
    fig.tight_layout()
    fig.savefig("fig2_vantoff_deviation.png")
    plt.close(fig)

def fig3():
    dCp_g = np.linspace(-2600.0, -200.0, 301)
    Tg_ = np.linspace(-25.0, 60.0, 426)
    DC, TT = np.meshgrid(dCp_g, Tg_)
    resp = np.where(dH_T(TT, DC) < 0.0, 1.0, -1.0)      # +1 cooling tightens
    ratio = np.log10(Kd_2s(TT, DC)/Kd_ref)
    cmap_disc = ListedColormap(["#B2182B", "#2166AC"])
    norm_disc = BoundaryNorm([-1.5, 0.0, 1.5], 2)
    fig, axes = plt.subplots(1, 2, figsize=(12.2, 4.7))
    ax = axes[0]
    im = ax.pcolormesh(dCp_g, Tg_, resp, cmap=cmap_disc, norm=norm_disc, shading="auto")
    cs = ax.contour(DC, TT, ratio, levels=[-3, -2, -1, 0, 1],
                    colors="0.25", linewidths=0.7, linestyles="--")
    ax.clabel(cs, fmt="%.0f", fontsize=8)
    ax.plot(dCp_g, [T_H_c(d) for d in dCp_g], color="k", lw=2.4,
            label="DeltaH=0 (T_H, affinity extremum)")
    ax.plot(dCp_g, [T_S_c(d) for d in dCp_g], color="0.45", lw=1.6, ls="-.",
            label="DeltaS=0 (T_S, DeltaG min)")
    ax.set_xlabel("DeltaCp  /  cal mol-1 K-1")
    ax.set_ylabel("Temperature / C")
    ax.set_title("Two-state DeltaCp: response of affinity to cooling")
    for x in (-400.0, -800.0, -1500.0, -2300.0):
        ax.plot([x], [4.0], "o", ms=6, color=PAL[6], zorder=6)
        ax.annotate("%.0f" % x, (x, 9.5), fontsize=8, ha="center", color="0.15")
    ax.text(-2560, 45, "cooling tightens\n(exothermic, DeltaH<0)", fontsize=9,
            color="#1a3d7c")
    ax.text(-2560, -22, "cooling WEAKENS\n(endothermic, DeltaH>0)\ncold-reversal band",
            fontsize=8.5, color="#7a1111", va="top")
    ax.set_ylim(-25, 60)
    ax.legend(loc="upper left", fontsize=8.5)
    cbi = fig.colorbar(im, ax=ax, ticks=[-1.0, 0.0, 1.0], fraction=0.045, pad=0.02)
    cbi.ax.set_yticklabels(["cooling weakens\n(DeltaH>0)", "", "cooling tightens\n(DeltaH<0)"],
                           fontsize=7.5)
    ax2 = axes[1]
    for dCp, c in zip((-400.0, -800.0, -1500.0, -2300.0),
                      (PAL[0], PAL[2], PAL[3], PAL[4])):
        ax2.semilogy(Tg_, Kd_2s(Tg_, dCp), color=c, lw=2.0,
                     label="DeltaCp = %+.0f" % dCp)
        th = T_H_c(dCp=dCp)
        ax2.semilogy([th], [Kd_2s(th, dCp)], "o", ms=6, color=c)
    ax2.axhline(Kd_ref, color="0.5", ls=":", lw=1.4)
    ax2.text(-24, Kd_ref*3.2, "Kd(25 C) = 5 pM", fontsize=8, color="#444444")
    ax2.axvspan(0, 10, color="#F7E2DE")
    ax2.axvspan(30, 42, color="#EDEDED")
    ax2.set_xlabel("Temperature / C")
    ax2.set_ylabel("Kd / M  (log scale)")
    ax2.set_title("Kd cross-sections: min at T_H; cold-reversal band where T_H>0 C")
    ax2.legend(fontsize=8.5)
    fig.tight_layout()
    fig.savefig("fig3_affinity_phase.png")
    plt.close(fig)

def fig4():
    Tc = np.linspace(-2.0, 50.0, 521)
    scen = [
        ("A: dose-rich, two-state (DeltaCp=-800)", dict(Atot=1.0e-9, Ttot=3.0e-10,
         dCp=-800.0, amp=0.0, shed=0.0)),
        ("B: dose-limited, two-state (DeltaCp=-800)", dict(Atot=3.0e-10, Ttot=3.0e-10,
         dCp=-800.0, amp=0.0, shed=0.0)),
        ("C: engineered + water fragility", dict(Atot=1.0e-9, Ttot=3.0e-10,
         dCp=-1500.0, amp=3500.0, shed=0.0)),
        ("D: B + shed-epitope decoy 2 nM", dict(Atot=3.0e-10, Ttot=3.0e-10,
         dCp=-800.0, amp=0.0, shed=2.0e-9)),
    ]
    def make_kf(prm):
        if prm["amp"] > 0:
            return lambda t: Kd_eff(t, dCp=prm["dCp"], amp=prm["amp"])
        return lambda t: Kd_2s(t, prm["dCp"])
    fig, axes = plt.subplots(1, 2, figsize=(12.2, 4.7))
    ax = axes[0]
    cols = ["#0072B2", "#D55E00", "#009E73", "#CC79A7"]
    deriv = {}
    for (name, prm), c in zip(scen, cols):
        kf = make_kf(prm)
        th = np.empty_like(Tc)
        for i, t in enumerate(Tc):
            decs = [(prm["shed"], kf(25.0))] if prm["shed"] > 0 else []
            th[i], _, _ = theta_target(t, kf, prm["Atot"], prm["Ttot"], decs)
        ax.plot(Tc, th*100.0, color=c, lw=2.0, label=name)
        deriv[name] = np.gradient(th, Tc)
    ax.axvspan(30, 42, color="#EDEDED")
    ax.axvspan(-2, 10, color="#FBE9E7")
    ax.text(36, 5, "in vivo", ha="center", fontsize=8, color="#555555")
    ax.text(4, 5, "cold zone", ha="center", fontsize=8, color="#9a3b3b")
    ax.set_xlabel("Temperature / C")
    ax.set_ylabel("Target occupancy / %")
    ax.set_ylim(-2, 105)
    ax.set_title("Target occupancy vs temperature (competitive mass action)")
    ax.legend(fontsize=8.0, loc="lower left")
    ax2 = axes[1]
    for (name, _), c in zip(scen, cols):
        ax2.plot(Tc, np.abs(deriv[name])*100.0, color=c, lw=2.0, label=name)
    ax2.set_xlabel("Temperature / C")
    ax2.set_ylabel("Occupancy-loss rate |dtheta/dT| / % per C")
    ax2.set_title("Avalanche sensitivity to temperature micro-wobble")
    ax2.legend(fontsize=8.0)
    fig.tight_layout()
    fig.savefig("fig4_occupancy_avalanche.png")
    plt.close(fig)

def fig5():
    Tc = np.linspace(0.0, 50.0, 401)
    fig, axes = plt.subplots(1, 2, figsize=(12.2, 4.7))
    ax = axes[0]
    for amp, c in zip((0.0, 2500.0, 5000.0), ("#0072B2", "#D55E00", "#009E73")):
        Ke = np.array([Kd_eff(t, dCp=CANON, amp=amp) for t in Tc])
        ax.semilogy(Tc, Ke, color=c, lw=2.2,
                    label="fragility scale W0 = %5.0f cal/mol" % amp)
    ax.axvspan(2, 8, color="#FBE9E7")
    ax.axvspan(30, 42, color="#EDEDED")
    ax.text(5, 3.0e-13, "cold storage\n2-8 C", fontsize=8, ha="center", color="#9a3b3b")
    ax.text(36, 3.0e-13, "in vivo", fontsize=8, ha="center", color="#555555")
    ax.set_xlabel("Temperature / C")
    ax.set_ylabel("Effective (apparent) Kd / M  (log scale)")
    ax.set_title("Cold fragility collapses effective Kd below ~10 C")
    ax.legend(fontsize=9)
    ax2 = axes[1]
    tau_int = 1.0/np.array([koff_intrinsic(t) for t in Tc])
    tau_app = 1.0/np.array([koff_apparent(t) for t in Tc])
    ax2.semilogy(Tc, tau_int/3600.0, color=PAL[0], lw=2.0,
                 label="intrinsic residence (bound-state k_off)")
    ax2.semilogy(Tc, tau_app/3600.0, color=PAL[1], lw=2.4, ls="--",
                 label="ensemble apparent residence")
    ax2b = ax2.twinx()
    ph = np.array([phi_cold(t) for t in Tc])
    ax2b.fill_between(Tc, 0.0, ph*100.0, color="#CC79A7", alpha=0.22)
    ax2b.plot(Tc, ph*100.0, color="#CC79A7", lw=1.4, label="cold-perturbed fraction phi")
    ax2b.set_ylabel("phi / %", color="#CC79A7")
    ax2b.tick_params(axis="y", colors="#CC79A7")
    ax2b.spines["right"].set_visible(False)
    ax2b.set_ylim(0, 105)
    for t in (4, 25, 37):
        ax2.semilogy([t], [1.0/koff_apparent(t)/3600.0], "o", ms=6, color="0.2")
    ax2.axvspan(2, 8, color="#FBE9E7", alpha=0.5)
    ax2.axvspan(30, 42, color="#EDEDED")
    ax2.set_xlabel("Temperature / C")
    ax2.set_ylabel("Residence time / h  (log scale)")
    ax2.set_title("Ensemble residence time: cold kinetic reversal")
    h1, l1 = ax2.get_legend_handles_labels()
    h2, l2 = ax2b.get_legend_handles_labels()
    ax2.legend(h1 + h2, l1 + l2, fontsize=8.2, loc="lower right")
    fig.tight_layout()
    fig.savefig("fig5_water_koff.png")
    plt.close(fig)

# ------------------------------------------------------------------- main
def main():
    summary()
    fig1()
    fig2()
    fig3()
    fig4()
    fig5()
    print("\nPNG figures + sim_summary.txt written.")

if __name__ == "__main__":
    main()
