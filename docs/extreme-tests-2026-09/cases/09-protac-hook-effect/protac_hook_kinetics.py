#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
protac_hook_kinetics.py
=======================
Rigorous equilibrium modelling of PROTAC ternary-complex formation and the
"Hook effect" (self-inhibition / hook effect at high PROTAC dose), prototype:
BRD4-targeting degraders (ARV-771 / dBET6 classes).

Model (closed, homogeneous, single-reactor, full mass conservation — NO
P_free ~= P_tot shortcut):
    E + P <-> EP            Kd2 = [E][P]/[EP]
    P + T <-> PT            Kd1 = [P][T]/[PT]
    EP + T <-> EPT          Kd1' = Kd1/alpha     (ternary arm 1)
    PT + E <-> EPT          Kd2' = Kd2/alpha     (ternary arm 2; identical by
                                                   microscopic reversibility)
  => [PET] = alpha*[E][P][T]/(Kd2*Kd1)            (mass action)

Unknowns: free [E], [P], [T].  Three NONLINEAR mass-balance equations:
    T_tot = [T] + [PT] + [PET]
    E_tot = [E] + [EP] + [PET]
    P_tot = [P] + [PT] + [EP] + [PET]
Solved exactly on a log P_tot grid with scipy.optimize.least_squares and
continuation initial guesses (variables log10-transformed, box-bounded).

alpha = cooperativity factor = Kd1/Kd1'  (>1 positive, <1 negative, =1 neutral).

Reference analytical optimum (excess-ligand, depletion-free limit; flagged):
    P*_ana = sqrt(Kd1 * Kd2)      (peak POSITION is alpha-independent in that limit)

Parameter provenance (STRICT measured-vs-assumption separation, see REPORT):
  S1 dBET6-like (CRBN):
     Kd1 = 50 nM   dBET6->BRD4 binding IC50 50.2/80.5 nM (ChEMBL CHEMBL4303781);
                   JQ1 Kd(BD1) = 49 nM (ChEMBL CHEMBL1957266)          [MEASURED proxy]
     Kd2 = 134 nM  dBET6->CRBN-DDB1 binary binding IC50 (ChEMBL CHEMBL4303781);
                   free-imide family 0.25-3 uM across methods          [MEASURED proxy]
  S2 ARV-771-like (VHL):
     Kd1 = 8 nM    ARV-771->BRD4 Kd 7.6 nM (BD2)/9.6 nM (BD1)          [MEASURED]
     Kd2 = 100 nM  VHL-arm: NO published binary Kd for ARV-771 (Data Gap);
                   class anchor MZ1->VCB Kd = 66 nM (ITC, Gadd 2017);   [ASSUMED baseline]
     alpha          For dBET6/ARV-771 a clean ITC/SPR alpha is not public.
                    Measured anchors used to bound the scan: JQ1-VHL MZ1/BD2 alpha=18,
                    BD1 2-3, AT1=7 (ITC, Gadd 2017); CRBN-based dBET6: no resolved PPI
                    in HDX-MS => expected modest. alpha is therefore a SCANNED
                    simulation parameter: 0.1 / 1 / 10 / 50.             [SIMULATION]
  E_tot = T_tot = 40 nM  (cell-like closed-reactor level; the concentration used in
                          the ITC-based ternary-population simulations of Gadd 2017)
                                                                         [ASSUMED]

Outputs:
  * console table of per-alpha metrics
  * publication-grade two-panel PNG: fig_hook_kinetics.png
Usage:
    python protac_hook_kinetics.py                 # dBET6-like, alphas 0.1 1 10 50
    python protac_hook_kinetics.py --scenario ARV771 --alphas 0.1 1 10 50 --out fig2.png
"""

import argparse
import numpy as np
from scipy.optimize import least_squares, minimize_scalar

# --------------------------------------------------------------------------- #
# Scenario database (M = molar)
# --------------------------------------------------------------------------- #
SCENARIOS = {
    "dBET6": dict(name="dBET6-like (CRBN)", Kd1=50e-9, Kd2=134e-9,
                  provenance="Kd1: dBET6->BRD4 bind. IC50 50 nM / JQ1 Kd 49 nM "
                             "(ChEMBL). Kd2: dBET6->CRBN-DDB1 bind. IC50 134 nM "
                             "(ChEMBL). [MEASURED proxy; imide family 0.25-3 uM]"),
    "ARV771": dict(name="ARV-771-like (VHL)", Kd1=8e-9, Kd2=100e-9,
                   provenance="Kd1: ARV-771->BRD4 Kd 7.6/9.6 nM [MEASURED]. "
                              "Kd2: VHL-arm binary Kd not published (Data Gap); "
                              "class anchor MZ1->VCB Kd=66 nM ITC [ASSUMED baseline]"),
}


def ternary_free(Etot, Ttot, Ptot, Kd1, Kd2, alpha, z_guess=None, xtol=1e-13):
    """Solve the full 3-equation mass balance for free {E,P,T}.

    Returns dict with free concentrations and all complex concentrations (M).
    No P_free ~= P_tot approximation is used anywhere.
    """
    def resid(z):
        E, P, T = np.power(10.0, z)
        EP = E * P / Kd2
        PT = P * T / Kd1
        PET = alpha * E * P * T / (Kd2 * Kd1)
        return np.array([(T + PT + PET) / Ttot - 1.0,
                         (E + EP + PET) / Etot - 1.0,
                         (P + PT + EP + PET) / Ptot - 1.0])

    if z_guess is None:
        z0 = np.log10(np.clip([Etot, Ptot, Ttot], 1e-18, None))
    else:
        z0 = np.log10(np.clip(z_guess, 1e-18, None))
    lo = np.log10([1e-9 * Etot, max(1e-16, Ptot * 1e-9), 1e-9 * Ttot])
    hi = np.log10([Etot, max(Ptot, 1e-16), Ttot])
    sol = least_squares(resid, z0, bounds=(lo, hi), xtol=xtol, ftol=xtol,
                        max_nfev=8000)
    E, P, T = np.power(10.0, sol.x)
    EP = E * P / Kd2
    PT = P * T / Kd1
    PET = alpha * E * P * T / (Kd2 * Kd1)
    return dict(E=E, P=P, T=T, EP=EP, PT=PT, PET=PET, cost=float(sol.cost))


def ternary_dose_response(Ptot_arr, Etot, Ttot, Kd1, Kd2, alpha):
    """Continuation solve of [PET] over a (sorted) P_tot array."""
    P = np.sort(np.asarray(Ptot_arr, dtype=float))
    out, z_guess = [], None
    for pt in P:
        r = ternary_free(Etot, Ttot, pt, Kd1, Kd2, alpha, z_guess)
        z_guess = np.array([r["E"], r["P"], r["T"]])
        out.append(r)
    return out


def peak_metrics(Ptot_grid, Etot, Ttot, Kd1, Kd2, alpha):
    """Return refined peak amplitude/position and half-max log window."""
    r = ternary_dose_response(Ptot_grid, Etot, Ttot, Kd1, Kd2, alpha)
    PET = np.array([d["PET"] for d in r])
    imax = int(np.argmax(PET))
    n = len(Ptot_grid)

    def neg(logp):
        return -ternary_free(Etot, Ttot, 10 ** logp, Kd1, Kd2, alpha)["PET"]

    lo_b = np.log10(Ptot_grid[max(0, imax - 3)])
    hi_b = np.log10(Ptot_grid[min(n - 1, imax + 3)])
    opt = minimize_scalar(neg, bounds=(lo_b, hi_b), method="bounded",
                          options={"xatol": 1e-3})
    Pstar, PETmax = 10 ** opt.x, -opt.fun

    logP = np.log10(Ptot_grid)
    half = 0.5 * PETmax
    idx = np.where(PET >= half)[0]
    li, ri = (idx[0] if len(idx) else None), (idx[-1] if len(idx) else None)

    def cross(i_edge, up):
        """interpolate log10 P where PET crosses 'half' between i_edge-1 & i_edge."""
        if up:                       # right descending crossing
            i0, i1 = i_edge, i_edge + 1
        else:                        # left ascending crossing
            i0, i1 = i_edge - 1, i_edge
        x0, x1, y0, y1 = logP[i0], logP[i1], PET[i0], PET[i1]
        if abs(y1 - y0) < 1e-30:
            return np.nan
        return x0 + (half - y0) * (x1 - x0) / (y1 - y0)

    logP_left = cross(li, False) if (li is not None and li > 0) else (logP[0] if li == 0 else np.nan)
    logP_right = cross(ri, True) if (ri is not None and ri < n - 1) else (logP[-1] if ri == n - 1 else np.nan)
    W = logP_right - logP_left if not (np.isnan(logP_left) or np.isnan(logP_right)) else np.nan
    return dict(PETmax=PETmax, Pstar=Pstar, logP_left=logP_left,
                logP_right=logP_right, halfmax_window=W)


def run_scenario(keyscen, alphas=(0.1, 1.0, 10.0, 50.0), n=500,
                 Etot=40e-9, Ttot=40e-9):
    scen = SCENARIOS[keyscen]
    Kd1, Kd2 = scen["Kd1"], scen["Kd2"]
    grid = np.logspace(-14, -3, n)          # extended grid for metrics
    curves, metrics = {}, {}
    for a in alphas:
        r = ternary_dose_response(grid, Etot, Ttot, Kd1, Kd2, a)
        curves[a] = np.array([d["PET"] for d in r])
        metrics[a] = peak_metrics(grid, Etot, Ttot, Kd1, Kd2, a)
    return dict(scenario=scen, Etot=Etot, Ttot=Ttot, Kd1=Kd1, Kd2=Kd2,
                alphas=list(alphas), grid=grid, curves=curves, metrics=metrics,
                Pana=np.sqrt(Kd1 * Kd2))


# --------------------------------------------------------------------------- #
# Figure
# --------------------------------------------------------------------------- #
def alpha_color(alpha, lo=-1.0, hi=np.log10(50.0)):
    """Colour of an alpha-series on the shared log10(alpha)-scaled viridis map."""
    import matplotlib.pyplot as _plt
    t = (np.log10(alpha) - lo) / (hi - lo)
    return _plt.cm.viridis(np.clip(t, 0, 1))


def make_figure(res, out="fig_hook_kinetics.png", show_max_pts=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D

    plt.rcParams.update({"font.size": 9, "axes.linewidth": 0.8,
                         "xtick.direction": "in", "ytick.direction": "in"})
    fig = plt.figure(figsize=(7.6, 3.55), dpi=150)
    gs = fig.add_gridspec(1, 2, width_ratios=[1.28, 1.0], wspace=0.32,
                          left=0.085, right=0.985, top=0.93, bottom=0.15)
    Pt_plot = np.logspace(-12, -4, 300)     # required assay window 1e-12..1e-4 M
    Kd1, Kd2 = res["Kd1"], res["Kd2"]
    Etot, Ttot = res["Etot"], res["Ttot"]

    # ---- Panel A: ternary dose-response ----
    axA = fig.add_subplot(gs[0])
    for a in res["alphas"]:
        r = ternary_dose_response(Pt_plot, Etot, Ttot, Kd1, Kd2, a)
        PET = np.array([d["PET"] for d in r]) * 1e9          # nM
        col = alpha_color(a)
        axA.plot(Pt_plot, PET, color=col, lw=1.8, zorder=3, label=rf"$\alpha$ = {a:g}")
        m = res["metrics"][a]
        axA.plot(m["Pstar"], m["PETmax"] * 1e9, "o", ms=6, mec="k", mew=0.6,
                 mfc=col, zorder=5)
    Pana = res["Pana"]
    axA.axvline(Pana, color="k", ls=(0, (4, 2)), lw=1.0, zorder=2)
    axA.annotate(r"$P^{*}_{\mathrm{ana}}=\sqrt{K_{d1}K_{d2}}$" + f" = {Pana*1e9:.0f} nM",
                 xy=(Pana, 3e1), xytext=(Pana * 1.15, 2.2e1), fontsize=7.6,
                 arrowprops=dict(arrowstyle="-", lw=0.7, color="k"))
    axA.axhline(min(Etot, Ttot) * 1e9, color="0.55", lw=0.8, ls=":")
    axA.text(6e-6, 0.82 * min(Etot, Ttot) * 1e9,
             "ceiling = min($E_{{tot}},T_{{tot}}$) = {:.0f} nM".format(min(Etot, Ttot) * 1e9),
             fontsize=7.2, color="0.35", ha="right", va="center")
    axA.annotate("Hook / self-inhibition\n(high-[PROTAC] descending arm)",
                 xy=(3.2e-5, 5.2e-1), xytext=(1.6e-6, 4.5e0), fontsize=7.4,
                 color="0.2", ha="left",
                 arrowprops=dict(arrowstyle="->", lw=0.9, color="0.3"))
    axA.set_xscale("log"); axA.set_yscale("log")
    axA.set_xlabel("Total PROTAC concentration, [$P$]$_{tot}$  (M)")
    axA.set_ylabel("Ternary complex  [$P{\\cdot}E{\\cdot}T$]  (nM)")
    axA.set_xlim(1e-12, 1e-4); axA.set_ylim(5e-5, 60)
    axA.legend(loc="lower right", fontsize=7.6, frameon=False, handlelength=1.6)
    axA.set_title("A   Ternary dose–response ({})".format(res["scenario"]["name"]),
                  fontsize=9.5, loc="left", pad=4)

    # ---- Panel B: alpha dependence of peak amplitude & hook window ----
    axB = fig.add_subplot(gs[1])
    axW = axB.twinx()
    axW.set_zorder(axB.get_zorder() - 1)
    alphas = res["alphas"]
    amax = [res["metrics"][a]["PETmax"] * 1e9 for a in alphas]
    W = [res["metrics"][a]["halfmax_window"] for a in alphas]
    cols = [alpha_color(a) for a in alphas]
    axB.semilogx(alphas, amax, color="0.45", lw=1.0, zorder=2)
    axB.scatter(alphas, amax, s=46, facecolors=cols, edgecolors="k",
                linewidths=0.7, zorder=4)
    axW.semilogx(alphas, W, color="0.75", lw=1.0, ls=(0, (3, 2)), zorder=2)
    axW.scatter(alphas, W, s=30, facecolors="none", edgecolors=cols,
                linewidths=1.4, zorder=5)
    axB.axvspan(2, 18, color="0.92", zorder=0)
    axB.text(6, 1.35, "measured α range\nJQ1–VHL series (ITC)", fontsize=6.4,
             color="0.4", ha="center", va="bottom")
    axB.axhline(min(Etot, Ttot) * 1e9, color="0.55", lw=0.8, ls=":")
    axB.text(0.12, 43, "min($E_{tot},T_{tot}$)", fontsize=6.8, color="0.35")
    axB.set_xscale("log")
    axB.set_xlim(0.08, 90); axB.set_ylim(0, 60); axW.set_ylim(0, 3.2)
    axB.set_xlabel("Cooperativity factor, $\\alpha$  =  $K_{d1}/K^{\\prime}_{d1}$")
    axB.set_ylabel("Peak [$P{\\cdot}E{\\cdot}T$]$_{max}$  (nM)")
    axW.set_ylabel("Half-max log-window,  $\\Delta\\log_{10}[P]$  (decades)")
    axB.set_title("B   α controls peak amplitude & hook window, not $P^{*}$",
                  fontsize=9.5, loc="left", pad=4)
    handles = [Line2D([], [], marker="o", ls="-", color="0.45", markerfacecolor="0.6",
                      markeredgecolor="k", ms=6,
                      label="peak [$P{\\cdot}E{\\cdot}T$]$_{max}$ (left)"),
               Line2D([], [], marker="o", ls=(0, (3, 2)), color="0.75",
                      markerfacecolor="none", markeredgecolor="0.4", ms=5,
                      label="half-max window $\\Delta\\log_{10}[P]$ (right)")]
    axB.legend(handles=handles, loc="center right", fontsize=6.8, frameon=False)
    axB.text(0.12, 13.0, "P* pinned ≈ {:.0f} nM for all α\n(analytic {:.0f} nM)"
             .format(res["metrics"][alphas[0]]["Pstar"] * 1e9, res["Pana"] * 1e9),
             fontsize=6.6, color="0.25", ha="left", va="top", linespacing=1.3)
    fig.savefig(out, dpi=300)
    print("figure written:", out)
    return out


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenario", choices=list(SCENARIOS), default="dBET6")
    ap.add_argument("--alphas", nargs="+", type=float,
                    default=[0.1, 1.0, 10.0, 50.0])
    ap.add_argument("--out", default="fig_hook_kinetics.png")
    ap.add_argument("--n", type=int, default=500)
    args = ap.parse_args()

    res = run_scenario(args.scenario, alphas=tuple(args.alphas), n=args.n)
    print("Scenario:", res["scenario"]["name"])
    print("  Kd1 (PROTAC-target) = {:.3g} M   Kd2 (PROTAC-E3) = {:.3g} M".format(
        res["Kd1"], res["Kd2"]))
    print("  E_tot = T_tot = {:.0f} nM   P*_analytic = sqrt(Kd1*Kd2) = {:.4g} M".format(
        res["Etot"] * 1e9, res["Pana"]))
    print("  provenance:", res["scenario"]["provenance"])
    print(f"{'alpha':>6} {'PETmax(M)':>12} {'P*(M)':>11} "
          f"{'logP_left':>9} {'logP_right':>10} {'W(log10)':>9}")
    for a in res["alphas"]:
        m = res["metrics"][a]
        print(f"{a:>6.1f} {m['PETmax']:>12.4e} {m['Pstar']:>11.4e} "
              f"{m['logP_left']:>9.3f} {m['logP_right']:>10.3f} "
              f"{m['halfmax_window']:>9.3f}")
    make_figure(res, args.out)


if __name__ == "__main__":
    main()
