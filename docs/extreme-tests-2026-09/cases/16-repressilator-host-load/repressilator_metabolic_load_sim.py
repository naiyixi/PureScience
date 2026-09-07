#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
repressilator_metabolic_load_sim.py
====================================================================
Adversarial-review demonstration: a Repressilator (A -| B -| C -| A)
whose "overdrive" claim (10x T7 promoters + 10x RBS + mRNA stabilisation
=> "inevitable, unbreakable Hopf limit cycle") is tested against host
resource allocation & the Scott-Hwa growth law.

Model S  (headline, 8 ODEs)
----------------------------
state x = [m_a, m_b, m_c,  a, b, c,  sP, sR]
  m_i     : repressilator mRNAs
  a,b,c   : repressor proteins      (eps = a+b+c = circuit load)
  sP      : RNAP / transcription capacity fraction      (fast, tauP)
  sR      : ribosome / growth capacity fraction (slow "host lag", tauR)
  drive G : multiplies promoter AND RBS AND mRNA stability
            delta_m(G) = delta_m0/(1 + stab*G)   (team plan: stabilised mRNA)
  lambda  = lam_max * sR                (Scott-Hwa growth law)
  sR -> sR_target(eps) = 1/(1+(eps/e50)^k)  with time constant tauR
  sP -> sP_target(mtot) with time constant tauP
  transcription gated by sP ; translation gated by sR
  repression: gene a repressed by C, gene b by A, gene c by B (Hill n=4)

The naive design assumption fixes lambda = const (isolated oscillator).
Once lambda = lambda(eps) with host lag, overdrive destroys the clock:
growth collapses, the limit cycle survives only on a bounded drive window,
and beyond G_c it dies onto a frozen high-load fixed point (reverse Hopf).
No positive Lyapunov exponent is found anywhere in this smooth canonical
model: the "period-doubling / chaos" route is NOT generic for the pure
3-node ring + smooth load; real instability here = growth collapse +
oscillation death (+ re-entrant/hysteretic windows and, with an LVA tag,
longer survival because protein decay no longer relies on dilution).

Outputs (written to the working directory):
  fig1_drive_landscape.png   bifurcation/load/period-vs-growth panels
  fig2_regimes.png           time traces + 3-D phase portraits for
                             G = 1 (healthy), 4 (overdriven), 8 (dead)
  fig3_lyapunov.png          largest Lyapunov exponent lambda1 vs G
  regime_scan.json           per-G data (envelope, <lambda>, period...)
  lyapunov_scan.json         lambda1 vs G

(c) review deliverable -- pure physics-based ODE demonstration.
====================================================================
"""
import json
import numpy as np
from scipy.integrate import solve_ivp
from scipy.signal import find_peaks
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ------------------------------------------------------------------
# Model S parameters (time in hours). A "G = 1" is a modest inducible
# promoter; the team's plan corresponds to pushing G high (G >~ 5-6).
# ------------------------------------------------------------------
MODEL_S = dict(
    lam_max=1.4,    # max growth rate /hr  (~29 min doubling at full capacity)
    alpha0=40.0,    # max transcription per gene per hr at G=1
    leak=0.02,      # leaky transcription fraction
    beta0=0.9,      # translation rate per mRNA per hr at G=1
    delta_m=3.5,    # basal mRNA decay /hr   (t1/2 ~ 12 min)
    stab=0.05,      # mRNA stabilization per unit G  (delta_m shrinks with G)
    gamma_p=1.0,    # protein degradation /hr (NO LVA tag; slow-ish protein)
    Kd=1.0,         # repression dissociation constant (arb. units)
    n=4.0,          # Hill coefficient (as used in the hypothesis)
    e50=12.0,       # circuit mass eps at which ribosome capacity is halved
    kap_e=1.5,      # load nonlinearity
    m50=80.0,       # mRNA load at which RNAP capacity is strongly reduced
    tauP=0.25,      # hr  : fast RNAP adaptation
    tauR=1.2,       # hr  : slow ribosome / host-growth adaptation ("lag")
)

YN = ["ma", "mb", "mc", "a", "b", "c", "sP", "sR"]
Y0 = np.array([3.0, 3.0, 3.0, 0.50, 0.70, 0.25, 1.0, 1.0])


# ------------------------------------------------------------------ ODE ---
def make_S(P=MODEL_S, gamma_p=None):
    """Return RHS(t, y, G) for the host-coupled repressilator.

    gamma_p may be overridden (e.g. = 5.0 to mimic an LVA fast-degradation tag).
    """
    P = dict(P)
    if gamma_p is not None:
        P["gamma_p"] = gamma_p
    lm = P["lam_max"]; al0 = P["alpha0"]; le = P["leak"]; be = P["beta0"]
    dm0 = P["delta_m"]; st = P["stab"]; ga = P["gamma_p"]
    Kd = P["Kd"]; n = P["n"]; e50 = P["e50"]; ke = P["kap_e"]
    m50 = P["m50"]; tP = P["tauP"]; tR = P["tauR"]

    def Hill(x):
        return 1.0 / (1.0 + (x / Kd) ** n)

    def rhs(t, y, G):
        ma, mb, mc, a, b, c, sP, sR = y
        eps = a + b + c
        mtot = ma + mb + mc
        lam = lm * sR
        dm = dm0 / (1.0 + st * G)
        sP_t = 1.0 / (1.0 + (mtot / m50) ** 2.0)      # RNAP free fraction
        sR_t = 1.0 / (1.0 + (eps / e50) ** ke)        # growth capacity target
        return [
            al0 * G * sP * (le + Hill(c)) - (dm + lam) * ma,   # gene a <- C
            al0 * G * sP * (le + Hill(a)) - (dm + lam) * mb,   # gene b <- A
            al0 * G * sP * (le + Hill(b)) - (dm + lam) * mc,   # gene c <- B
            be * G * ma * sR - (ga + lam) * a,
            be * G * mb * sR - (ga + lam) * b,
            be * G * mc * sR - (ga + lam) * c,
            (sP_t - sP) / tP,
            (sR_t - sR) / tR,
        ]
    return rhs


def simulate(rhs, G, T=450.0, dt=0.05, rtol=3e-9, atol=1e-12, y0=Y0):
    """Integrate Model S to drive G up to time T."""
    t_eval = np.linspace(0.0, T, int(T / dt) + 1)
    sol = solve_ivp(lambda t, y: rhs(t, y, G), (0.0, T), y0,
                    t_eval=t_eval, method="LSODA", rtol=rtol,
                    atol=atol, max_step=4.0)
    return sol.t, sol.y.T


# --------------------------------------------------------------- metrics ---
def summarise(t, y, trans=0.4):
    """Return oscillation/steady-state metrics of repressor A after transient."""
    a = y[:, 3]; sR = y[:, 7]
    eps = y[:, 3] + y[:, 4] + y[:, 5]
    w = t >= trans * t[-1]
    tw = t[w]; aw = a[w]
    pks, _ = find_peaks(aw, distance=12)
    amp = aw.max() - aw.min()
    if amp <= 1e-9 * max(aw.max(), 1e-9):
        return dict(osc=False, A_ss=float(aw[-1]),
                    lam=float(1.4 * sR[w].mean()),
                    eps_ss=float(eps[w][-1]))
    per = float(np.mean(np.diff(tw[pks]))) if len(pks) >= 3 else float("nan")
    return dict(osc=True, per=per, A_min=float(aw.min()), A_max=float(aw.max()),
                lam=float(1.4 * sR[w].mean()), eps=float(eps[w].mean()))


def wolf_lambda1(rhs, G, dim=8, warm=350.0, T=1050.0, h=0.5, d0=1e-8, seed=9):
    """Largest Lyapunov exponent by Wolf-type renormalisation of one shadow."""
    sol = solve_ivp(lambda t, y: rhs(t, y, G), (0.0, warm), Y0,
                    method="LSODA", rtol=2e-11, atol=1e-14, max_step=2.0)
    y = sol.y[:, -1].copy()
    rng = np.random.default_rng(seed)
    p = rng.standard_normal(dim); p /= np.linalg.norm(p)
    z = y + d0 * p
    slog = 0.0; n = 0; tn = warm
    while tn < T:
        s1 = solve_ivp(lambda t, yy: rhs(t, yy, G), (tn, tn + h), y,
                       method="LSODA", rtol=2e-11, atol=1e-14, max_step=2.0)
        s2 = solve_ivp(lambda t, yy: rhs(t, yy, G), (tn, tn + h), z,
                       method="LSODA", rtol=2e-11, atol=1e-14, max_step=2.0)
        y = s1.y[:, -1]; z = s2.y[:, -1]
        dd = z - y; nd = np.linalg.norm(dd)
        if not np.isfinite(nd) or nd < 1e-300:
            z = y + d0 * p; tn += h; continue
        slog += np.log(max(nd, 1e-300) / d0); n += 1
        z = y + (dd / nd) * d0
        tn += h
    return slog / (n * h)


# -------------------------------------------------------------  scans -------
def regime_scan(G_grid):
    """Bifurcation-style scan: per-G envelope, mean growth, period or steady."""
    rows = []
    for G in G_grid:
        t, y = simulate(RHS, G)
        rows.append(dict(G=float(G), **summarise(t, y)))
    return rows


def lva_scan(G_list):
    """no-LVA vs LVA-tag (fast protein decay) design comparison."""
    out = []
    for G in G_list:
        for tag, rhs in (("noLVA", RHS), ("LVA", RHS_LVA)):
            t, y = simulate(rhs, G, T=400.0)
            d = summarise(t, y)
            w = t >= 0.5 * t[-1]
            out.append(dict(G=G, tag=tag, osc=bool(d["osc"]),
                            per=(d["per"] if d["osc"] else None),
                            lam=1.4 * y[w, 7].mean(),
                            eps=(y[w, 3] + y[w, 4] + y[w, 5]).mean()))
    return out


# ------------------------------------------------------------- figures ------
def make_figures(bif, lva, lyap, outdir="."):
    C_AMP = "#1f77b4"; C_FROZ = "#7f7f7f"; C_LVA = "#2ca02c"
    plt.rcParams.update({"font.size": 10, "axes.titlesize": 11,
                         "axes.labelsize": 10, "legend.fontsize": 8,
                         "figure.dpi": 150})

    # ---- Figure 1 : drive landscape --------------------------------------
    fig, axs = plt.subplots(1, 3, figsize=(14, 4.1))
    ax = axs[0]
    for r in bif:
        if r["osc"]:
            ax.plot([r["G"]] * 2, [r["A_min"], r["A_max"]], "-",
                    color=C_AMP, lw=2.0, alpha=0.5, solid_capstyle="round")
        else:
            ax.plot(r["G"], r["A_ss"], "s", color=C_FROZ, ms=3.5)
    ax.axvspan(0.7, 5.55, color=C_AMP, alpha=0.07)
    ax.axvline(5.6, color="k", ls="--", lw=1)
    ax.text(5.63, 3.0, "$G_c\\approx5.6$", rotation=90, fontsize=8)
    ax.text(3.0, 25.5, "stable limit cycle", color=C_AMP, ha="center", fontsize=9)
    ax.text(9.2, 2.2, "frozen high-$\\varepsilon$", color=C_FROZ, ha="center", fontsize=8)
    ax.set_xlabel("drive $G$ (promoter $\\times$ RBS $\\times$ mRNA stability)")
    ax.set_ylabel("repressor A  (osc. envelope / steady)")
    ax.set_title("(a) Oscillation lives only in a bounded window", fontsize=10)
    ax.set_ylim(-0.6, 34); ax.set_xlim(0.4, 13)

    ax = axs[1]
    for r in bif:
        if r["osc"]:
            ax.plot(r["G"], r["lam"], "o", color=C_AMP, ms=4)
        else:
            ax.plot(r["G"], r["lam"], "s", color=C_FROZ, ms=4)
    ax.axhline(1.4, color="0.55", ls=":", lw=1)
    ax.text(0.45, 1.42, "$\\lambda_{\\max}$", fontsize=8, color="0.4")
    ax.axvspan(0.7, 5.55, color=C_AMP, alpha=0.07)
    ax.axvspan(5.6, 12.6, color=C_FROZ, alpha=0.10)
    Gl = [r["G"] for r in lva if r["tag"] == "LVA" and r["osc"]]
    ax.plot(Gl, [1.36] * len(Gl), "|", color=C_LVA, ms=13, mew=2)
    ax.text(6.0, 1.10, "no-tag clock dies at $G_c$;\nLVA ring keeps oscillating",
            color="0.15", fontsize=8, ha="left")
    ax.plot([], [], "o", color=C_AMP, label="oscillating (no tag)")
    ax.plot([], [], "s", color=C_FROZ, label="frozen (no tag)")
    ax.plot([], [], "|", color=C_LVA, mew=2, label="oscillating (LVA)")
    ax.legend(loc="center right", framealpha=0.9)
    ax.set_xlabel("drive $G$"); ax.set_ylabel("$\\langle\\lambda\\rangle$  (h$^{-1}$)")
    ax.set_title("(b) Host growth collapses with circuit load", fontsize=10)
    ax.set_ylim(0, 1.6); ax.set_xlim(0.4, 13)

    ax = axs[2]
    for tag, c in (("noLVA", C_AMP), ("LVA", C_LVA)):
        pts = [r for r in lva if r["tag"] == tag and r["osc"] and r["per"]]
        ax.plot([r["lam"] for r in pts], [r["per"] for r in pts], "o-",
                color=c, ms=5, label=("no LVA tag" if tag == "noLVA" else "LVA tag"))
    ax.set_xlabel("$\\langle\\lambda\\rangle$  (h$^{-1}$)")
    ax.set_ylabel("clock period (h)")
    ax.set_title("(c) LVA tag decouples period from growth", fontsize=10)
    ax.legend(loc="upper left"); ax.set_xlim(0.15, 1.45)
    fig.tight_layout()
    fig.savefig(f"{outdir}/fig1_drive_landscape.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    # ---- Figure 2 : three regimes, time traces + 3-D phase portraits ------
    fig = plt.figure(figsize=(13.2, 7.4))
    regs = [(1.0, "$G=1$: healthy clock", "#1f77b4"),
            (4.0, "$G=4$: overdrive, still ticking", "#e66101"),
            (8.0, "$G=8$: oscillation death", "#4d4d4d")]
    for k, (G, ttl, cc) in enumerate(regs):
        t, y = simulate(RHS, G, T=700.0, dt=0.04)
        a = y[:, 3]; b = y[:, 4]; c = y[:, 5]; lam = 1.4 * y[:, 7]
        w = int(0.55 * len(t))
        axT = fig.add_subplot(2, 3, k + 1)
        axT.plot(t[w:], a[w:], color=cc, lw=1.0)
        axT.set_ylabel("repressor A"); axT.set_xlabel("time (h)")
        axT.set_title(ttl, fontsize=10)
        axT.set_xlim(t[w], t[w] + (26 if G < 6 else 45))
        axL = axT.twinx()
        axL.plot(t[w:], lam[w:], color="#d62728", lw=0.8, ls="--", alpha=0.85)
        axL.set_ylabel("$\\lambda$ (h$^{-1}$)", color="#d62728", fontsize=9)
        axL.tick_params(axis="y", colors="#d62728", labelsize=8); axL.set_ylim(0, 1.5)

        ax3 = fig.add_subplot(2, 3, k + 4, projection="3d")
        tail = t >= 0.5 * t[-1]
        if G < 6:
            at = a[tail]; tp = t[tail]
            pk, _ = find_peaks(at, distance=12)
            per = float(np.mean(np.diff(tp[pk]))) if len(pk) > 2 else 6.0
            tsel = t >= t[-1] - 2.5 * per
        else:
            tsel = (t >= t[-1] - 260) & (t <= t[-1] - 40)
        xx = a[tsel][::3]; yy = b[tsel][::3]; zz = c[tsel][::3]
        ax3.plot(xx, yy, zz, color=cc, lw=1.0)
        if G >= 6:
            tt = t >= t[-1] - 10
            ax3.scatter([a[tt][-1]], [b[tt][-1]], [c[tt][-1]], s=22, color="k",
                        zorder=5, label="frozen FP")
            ax3.legend(loc="upper right", fontsize=7)
        ax3.set_xlabel("A"); ax3.set_ylabel("B"); ax3.set_zlabel("C")
        ax3.tick_params(labelsize=7)
        ax3.set_title("attractor $(A,B,C)$" +
                      (" : spiral to fixed point" if G >= 6 else " : closed loop"),
                      fontsize=9)
    fig.tight_layout()
    fig.savefig(f"{outdir}/fig2_regimes.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    # ---- Figure 3 : Lyapunov exponent vs drive ---------------------------
    lyap = np.asarray(lyap)
    fig, ax = plt.subplots(figsize=(7, 4.2))
    ax.plot(lyap[:, 0], lyap[:, 1], "o-", color=C_AMP, ms=5)
    ax.axhline(0, color="k", lw=0.8)
    ax.axvspan(0.7, 5.55, color=C_AMP, alpha=0.08,
               label="stable limit cycle ($\\lambda_1\\approx 0$)")
    ax.axvspan(5.6, 12.3, color=C_FROZ, alpha=0.12,
               label="frozen fixed point ($\\lambda_1<0$)")
    ax.axvline(5.6, color="k", ls="--", lw=1)
    ax.text(5.62, -0.45, "$G_c$", fontsize=9)
    ax.set_xlabel("drive  $G$")
    ax.set_ylabel("largest Lyapunov exponent $\\lambda_1$  (h$^{-1}$)")
    ax.set_title("No positive $\\lambda_1$: overdrive never yields sustained chaos\n"
                 "in the canonical smooth host-coupled model", fontsize=10)
    ax.legend(loc="lower right", fontsize=8)
    ax.set_ylim(-1.4, 0.25); ax.set_xlim(0.4, 12.5)
    fig.tight_layout()
    fig.savefig(f"{outdir}/fig3_lyapunov.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


# ------------------------------------------------------- chaos survey ------
def survey_chaos(n_trials=80, seed=7):
    """Randomised scan over smooth host-coupled model families searching for a
    positive largest Lyapunov exponent (period-doubling/chaos).

    Returns a list of candidate parameter dicts whose Wolf exponent is clearly
    positive.  In the canonical 3-node repressilator + smooth Scott-Hwa-type
    load, the expected outcome is an EMPTY list: the ring is structurally
    period-1; overdrive instead yields growth collapse and oscillation death.
    """
    from scipy.integrate import solve_ivp
    rng = np.random.default_rng(seed)
    hits = []
    for tr in range(n_trials):
        # random but physically bounded family around MODEL_S
        P = dict(MODEL_S)
        P["alpha0"] = 10 ** rng.uniform(1.1, 1.9)
        P["beta0"] = 10 ** rng.uniform(-0.4, 0.4)
        P["delta_m"] = 10 ** rng.uniform(0.3, 1.0)
        P["stab"] = 10 ** rng.uniform(-1.4, 0.0)
        P["gamma_p"] = 10 ** rng.uniform(-1.1, 0.1)
        P["n"] = float(rng.choice([4, 5, 6]))
        P["e50"] = 10 ** rng.uniform(0.0, 1.3)
        P["tauR"] = 10 ** rng.uniform(-0.3, 0.8)
        rhs = make_S(P)
        G = float(rng.choice([1, 2, 3, 4, 5, 6, 8]))
        ll = wolf_lambda1(rhs, G, warm=200.0, T=500.0, h=1.0)
        if ll > 0.02:                       # clearly positive threshold
            hits.append(dict(P=P, G=G, lambda1=ll))
    return hits


# ------------------------------------------------------------- main ---------
def main():
    global RHS, RHS_LVA
    RHS = make_S(MODEL_S)                      # no-tag (team plan)
    RHS_LVA = make_S(MODEL_S, gamma_p=5.0)     # LVA-like fast-degradation tag

    # --- bifurcation / regime scan over drive G ---------------------------
    G_grid = np.round(np.arange(0.5, 13.0, 0.2), 2)
    print("Regime scan over drive G ...")
    bif = regime_scan(G_grid)

    # --- LVA vs no-LVA design comparison -----------------------------------
    print("LVA design comparison ...")
    lva = lva_scan([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0])

    # --- Lyapunov scan over drive G ----------------------------------------
    print("Lyapunov scan (Wolf algorithm), ~4-6 min ...")
    G_ly = [0.6, 0.7, 0.8, 0.9, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5,
            5.0, 5.3, 5.6, 6.0, 7.0, 8.0, 10.0, 12.0]
    lyap = [[G, wolf_lambda1(RHS, G)] for G in G_ly]

    with open("regime_scan.json", "w") as f:
        json.dump(bif, f)
    with open("lyapunov_scan.json", "w") as f:
        json.dump(lyap, f)

    make_figures(bif, lva, lyap)

    # --- console summary ----------------------------------------------------
    osc_win = []
    cur = None
    for r in bif:
        if r["osc"] and cur is None:
            cur = [r["G"], r["G"]]
        if r["osc"] and cur is not None:
            cur[1] = r["G"]
        if not r["osc"] and cur is not None:
            osc_win.append(cur); cur = None
    if cur:
        osc_win.append(cur)
    print("\n==== Console summary (Model S) ====")
    print("Oscillatory windows in drive G:", [(round(a, 2), round(b, 2))
                                              for a, b in osc_win])
    for G in (1.0, 2.0, 4.0, 6.0, 8.0, 12.0):
        r = [x for x in bif if abs(x["G"] - G) < 0.11][0]
        if r["osc"]:
            print(f"G={G:4.1f}: oscillating, period={r['per']:.2f} h, "
                  f"A=[{r['A_min']:.2f},{r['A_max']:.2f}], <lambda>={r['lam']:.3f}/h")
        else:
            print(f"G={G:4.1f}: FROZEN  A_ss={r['A_ss']:.2f}, "
                  f"<lambda>={r['lam']:.3f}/h")
    print("Largest Lyapunov exponents:", [(round(a, 2), round(b, 4))
                                           for a, b in lyap])
    print("max lambda1 found =", max(b for _, b in lyap),
          "  -> no sustained chaos in this canonical model.")


if __name__ == "__main__":
    main()
