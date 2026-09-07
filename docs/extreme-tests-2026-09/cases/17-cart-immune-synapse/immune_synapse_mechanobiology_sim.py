#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
immune_synapse_mechanobiology_sim.py
====================================
A critical-mechanism, semi-quantitative simulator of the "low antigen-density
escape" and the mechanotransduction thermodynamic paradox of ultra-high-affinity
CAR-T cells (adversarial engineering scenario: scFv Kd improved 10 nM -> 0.01 nM).

Physics encoded
----------------
1) KINETIC SEGREGATION / CD45 EXCLUSION  (spatial "density floor").
   The CAR-TAA bond (~10-15 nm apposition) is much shorter than the giant
   CD45/CD148 ectodomain (~30-40 nm).  A signalling-competent microcluster
   needs a *critical local density* of simultaneously engaged CARs that pin the
   two membranes into a sub-CD45 "close-contact" zone robust against thermal
   bending roughness.  An isolated sparse antigen, no matter how tightly bound,
   cannot nucleate such a zone.  Encoded as a Hill gate p_ex(e) over the number
   e of simultaneously engaged CARs inside a microcluster of radius r_mc.

2) KINETIC PROOFREADING  (temporal floor).
   Each engagement must survive >= tau_pr before ITAMs recruit ZAP70; an
   engagement that falls apart early contributes nothing: factor exp(-koff*tau_pr).

3) SERIAL TRIGGERING / TURNOVER AMPLIFICATION  (affinity ceiling).
   Downstream signalosomes adapt/desensitise, so a CAR that stays bound
   "forever" produces one finite wave of fresh signal and then holds the
   antigen hostage, blocking serial hand-off.  Physiologically the T cell needs
   "hit-and-run": engage -> activate -> release -> next hit.

4) KINETIC TRAPPING + RECEPTOR SINK + TONIC EXHAUSTION (ultra-affinity).
   A CAR with koff ~ 1e-5 s^-1 (Kd=0.01 nM) almost never detaches; the engaged
   CAR is internalised after ~tau_int, so it
     - cannot disengage from the killed target (long residence -> few contacts),
     - consumes the receptor pool ~4x faster per unit of delivered signal,
     - delivers continuous protected stimulation while stuck -> exhaustion.

5) CATCH-SLIP MECHANOBIOLOGY.
   koff is force-dependent (slip Bell term + a TCR-like catch window).  It shows
   that physiological traction (~10 pN) prolongs a TCR-like catch bond, but CAN
   NOT rescue an engineered pM-Kd complex whose zero-force lifetime already
   exceeds the entire synapse lifetime.

Caveat: this is an ILLUSTRATIVE MECHANISTIC MODEL (order-of-magnitude, not a
calibrated pharmacodynamic predictor). All constants are declared below.
"""

import os
import math
import numpy as np

# ----------------------------------------------------------------------
# Geometry / physical parameters
# ----------------------------------------------------------------------
A_CELL    = 500.0      # tumour cell surface area [um^2]
A_SYN     = 20.0       # apposed contact ("synapse patch") area [um^2]
R_MC      = 0.22       # microcluster correlation radius [um]
AREA_MC   = math.pi * R_MC**2          # microcluster footprint [um^2]

# --- binding kinetics (2D pseudo-first-order view) --------------------
KON_M     = 1.0e6      # intrinsic kon [M^-1 s^-1] (antibody/scFv-like)
KB        = 0.5        # antigen -> bound on-rate [s^-1] (local CAR supply)
TAU_PR    = 5.0        # kinetic proofreading time [s]
TAU_INT   = 240.0      # mean time before an ENGAGED protected CAR internalises [s]
K_INT     = 1.0/TAU_INT

# --- CD45 exclusion Hill gate -----------------------------------------
E_HALF    = 2.2        # engaged CARs for half-maximal exclusion
N_HILL    = 4.0        # steepness of the local-density threshold

# --- signal integration / lysis ---------------------------------------
THETA     = 4200.0     # protected CAR.s of signalling needed to trigger lysis
TAU_SYN   = 30.0       # synapse assembly floor [s]
T_ENC     = 900.0      # longest an unproductive/slow encounter is held [s]
TAU_GRAN  = 20.0       # granule delivery time after trigger [s]

# --- CAR pool / exhaustion (serial & iterative killing) ---------------
CAR_POOL0 = 1500.0     # CARs apposed/available per synapse region
TAU_REGEN = 4*3600.0   # CAR pool recovery time constant [s]
EX_STRONG = 1.0        # exhaustion units per successful strong kill
TAU_EX_REL= 500.0      # residence time at which tonic exhaustion is doubled
EX_MAX    = 6.0        # exhaustion ceiling (functional silencing)

# --- catch-slip curve --------------------------------------------------
KBT       = 4.11       # kT at 25 C [pN.nm]
X_SLIP    = 0.35       # slip distance [nm]
F_OPT     = 10.0       # force of maximal TCR-like catch lifetime [pN]
CATCH_AMP = 4.0        # catch enhancement factor
X_CATCH   = 0.30       # catch distance [nm]
W_F       = 6.0        # catch window width [pN]


# ======================================================================
# Rate / response primitives
# ======================================================================
def koff_from_kd(kd_m):
    """Intrinsic (F=0) dissociation rate from Kd via kon."""
    return KON_M * kd_m


def off_rate_force(koff0, F=0.0):
    """
    Force-modified off rate (two-pathway catch-slip form):
      koff(F) = koff0 * [ slip_term + (catch_term - 1) ]
    Catch prolongs the lifetime near F_opt (TCR-like); slip shortens it at high
    load.  An engineered rigid scFv is dominated by the slip term.
    """
    slip = math.exp(F*X_SLIP/KBT)
    gauss = math.exp(-0.5*((F-F_OPT)/W_F)**2)
    catch = math.exp(-F*X_CATCH/KBT) * (CATCH_AMP*gauss + 1.0)/(CATCH_AMP + 1.0)
    return koff0 * (slip + catch - 1.0)


def dwell_catch_slip(kd_m, F=0.0):
    """Mean bond lifetime (s) under force F for a given Kd."""
    return 1.0/off_rate_force(koff_from_kd(kd_m), F)


def p_occ(koff):
    """Steady occupancy of one antigen by a CAR (no CAR-number limitation)."""
    return KB/(KB + koff)


def hill(e, half=E_HALF, n=N_HILL):
    """CD45-exclusion / microcluster-competence gate vs engaged count e."""
    return e**n/(half**n + e**n)


def per_cluster_output(k, kd_m):
    """
    Protected-engaged signal of one microcluster with k antigens:
        e      = expected simultaneously engaged CARs,
        fprod  = probability a single engagement survives proofreading,
        output = e * fprod * p_ex(e)   [effective protected CARs].
    """
    koff = koff_from_kd(kd_m)
    e = k*p_occ(koff)
    fprod = math.exp(-koff*TAU_PR)
    return e*fprod*hill(e)


def car_lifetime_protected(kd_m):
    """
    Expected total protected signalling time (s) delivered by ONE CAR before it
    internalises (renewal process with exponential dwells).  A fast-off CAR is
    released (dwell < tau_int) and re-used many times; an ultra-tight CAR is
    internalised on its first engagement and delivers only ~tau_int of signal.
    """
    koff = koff_from_kd(kd_m)
    if koff <= 0:
        return TAU_INT
    x = koff*TAU_INT
    p_hold = math.exp(-x)            # P(dwell >= tau_int) -> CAR lost
    surv = 1.0 - p_hold              # P(dwell <  tau_int) -> CAR recycled
    if p_hold < 1e-12:
        p_hold = 1e-12
    if x < 1e-6:
        mean_short = TAU_INT/2.0
    else:
        mean_short = (1.0/koff)*(1.0 - (1.0+x)*math.exp(-x))/surv
    n_surv = surv/p_hold
    return max(TAU_INT, n_surv*mean_short + TAU_INT)


def release_time(bound, kd_m):
    """
    Time for the T cell to disengage from a target holding `bound` complexes.
    Each bond resolves at rate (koff + k_int); time to clear ~ (bound-1)/bound
    fraction of bonds.
    """
    koff = koff_from_kd(kd_m)
    if bound <= 0:
        return 0.0
    rate = koff + K_INT
    if rate <= 0:
        return np.inf
    return math.log(bound + 1.0)/rate


# ======================================================================
# Antigen geometry sampling -> microcluster sizes
# ======================================================================
def sample_synapse(n_copies, rng):
    """
    Number of antigen that actually sit inside the apposed synapse patch,
    assuming a uniform static distribution over the whole tumour cell surface
    (a moderately *favourable* assumption for the team: no active antigen
    recruitment is invoked).
    """
    lam = n_copies*A_SYN/A_CELL
    return int(rng.poisson(lam))


def sample_cluster_sizes(n_antigen, rng):
    """
    Uniform random antigen positions in the synapse patch; cluster by pair
    distance < r_mc (cKDTree + union-find).  Returns connected-component sizes.
    """
    if n_antigen <= 0:
        return []
    from scipy.spatial import cKDTree
    L = math.sqrt(A_SYN)
    xy = rng.uniform(0, L, size=(n_antigen, 2))
    pairs = cKDTree(xy).query_pairs(r=R_MC, output_type="ndarray")
    comp = np.arange(n_antigen)

    def find(a):
        while comp[a] != a:
            comp[a] = comp[comp[a]]
            a = comp[a]
        return a

    for i, j in pairs:
        ri, rj = find(int(i)), find(int(j))
        if ri != rj:
            comp[max(ri, rj)] = min(ri, rj)
    sizes = {}
    for i in range(n_antigen):
        r = find(i)
        sizes[r] = sizes.get(r, 0) + 1
    return list(sizes.values())


# ======================================================================
# Single-target (deterministic expectation)
# ======================================================================
def flux_from_clusters(sizes, kd_m):
    """Total protected-engaged signal flux across all clusters."""
    if not sizes:
        return 0.0
    return sum(per_cluster_output(k, kd_m) for k in sizes)


def first_kill_latency(sizes, kd_m):
    """Latency to cytolytic trigger (s), or inf if unreachable within T_ENC."""
    flux = flux_from_clusters(sizes, kd_m)
    if flux <= 0:
        return math.inf
    t = TAU_SYN + THETA/flux
    return t if t <= T_ENC else math.inf


# ======================================================================
# Event-driven Kinetic Monte Carlo of a single synapse
# ======================================================================
def kmc_single_synapse(sizes, kd_m, rng, tmax=None):
    """
    Exact Gillespie simulation of binding/unbinding of the sampled antigen
    microclusters.  Each antigen: free -> bound (rate KB), bound -> free (rate
    koff).  Integrates the instantaneous protected-engaged flux
        Phi(t) = sum_c e_c(t) * exp(-koff*tau_pr) * hill(e_c(t))
    and returns the first time the accumulated protected signalling THETA is
    reached (None if never within tmax).  Returns (t_first_kill, n_events).
    tmax defaults to the encounter window T_ENC.
    """
    if tmax is None:
        tmax = T_ENC
    koff = koff_from_kd(kd_m)
    fprod = math.exp(-koff*TAU_PR)
    ncl = len(sizes)
    t = 0.0
    acc = 0.0
    bound = np.zeros(ncl, dtype=np.int64)
    flags = [np.zeros(sizes[c], dtype=np.int8) for c in range(ncl)]
    next_t = np.full(ncl, np.inf)

    def phi():
        s = 0.0
        for c in range(ncl):
            e = bound[c]
            if e:
                s += e*fprod*hill(e)
        return s

    for c in range(ncl):
        r = (sizes[c]-bound[c])*KB + bound[c]*koff
        if r > 0:
            next_t[c] = t + rng.exponential(1.0/r)
    n_events = 0
    while t < tmax and acc < THETA:
        cmin = int(np.argmin(next_t))
        t_next = next_t[cmin] if np.isfinite(next_t[cmin]) else tmax
        # interval length is capped at tmax so we never overshoot the horizon
        dt = min(t_next, tmax) - t
        if dt <= 0:
            break
        ph = phi()
        # if the accumulated protected signal crosses THETA inside this
        # interval, interpolate the exact crossing time (important when the
        # next event is very far away, i.e. ultra-tight bonds barely unbind)
        if ph > 0 and acc + dt*ph >= THETA:
            t = t + (THETA - acc)/ph
            return t, n_events
        acc += dt*ph
        t += dt
        if t >= tmax:
            break
        # --- process the event at cmin ---
        n_events += 1
        k = sizes[cmin]
        r_bind = (k - bound[cmin])*KB
        r_unb = bound[cmin]*koff
        u = rng.random()*(r_bind + r_unb)
        if u < r_bind:
            idx = int(rng.integers(0, k))
            g = 0
            while flags[cmin][idx] == 1 and g < k:
                idx = (idx+1) % k
                g += 1
            if flags[cmin][idx] == 0:
                flags[cmin][idx] = 1
                bound[cmin] += 1
        else:
            idx = int(rng.integers(0, k))
            g = 0
            while flags[cmin][idx] == 0 and g < k:
                idx = (idx+1) % k
                g += 1
            if flags[cmin][idx] == 1:
                flags[cmin][idx] = 0
                bound[cmin] -= 1
        r = (k-bound[cmin])*KB + bound[cmin]*koff
        next_t[cmin] = t + (rng.exponential(1.0/r) if r > 0 else np.inf)
    return (None if acc < THETA else t), n_events


# ======================================================================
# Serial (iterative) killing over successive identical targets
# ======================================================================
def serial_killing_timeline(kd_m, n_copies, rng, t_fun=6.0*3600.0, max_hits=30):
    """
    Sequential encounters with fresh tumour cells of identical antigen copy
    number.  Tracks the CAR pool (sink), per-target commitment time (latency +
    granule + bond-release residence) and tonic exhaustion that accrues while
    the cell stays glued to a target.  Returns (kill_times [s], CAR pool list).
    """
    times = []
    pools = []
    t = 0.0
    pool = CAR_POOL0
    ex = 0.0
    koff = koff_from_kd(kd_m)
    p_hold = math.exp(-koff*TAU_INT)   # P(one dwell >= tau_int): CAR is lost
    while t < t_fun and len(times) < max_hits and pool > 30.0 and ex < EX_MAX:
        # ---- encounter one tumour cell ----
        n_ag = sample_synapse(n_copies, rng)
        sizes = sample_cluster_sizes(n_ag, rng)
        flux = flux_from_clusters(sizes, kd_m)
        if flux <= 0:
            t += min(T_ENC, t_fun - t)           # below density floor
            pool += (CAR_POOL0 - pool)*(1.0 - math.exp(-T_ENC/TAU_REGEN))
            continue
        latency = TAU_SYN + THETA/flux
        if latency > T_ENC:
            t += min(T_ENC, t_fun - t)
            pool += (CAR_POOL0 - pool)*(1.0 - math.exp(-T_ENC/TAU_REGEN))
            continue
        # ---- kill ----
        t += latency + TAU_GRAN
        b = min(n_ag*p_occ(koff), pool)
        lost = min(pool, b*p_hold)
        pool = max(0.0, pool - lost)
        times.append(t)
        pools.append(pool)
        # ---- disengage / migrate ----
        trel = release_time(b, kd_m)
        t += trel
        ex += EX_STRONG*(1.0 + trel/TAU_EX_REL)      # tonic exhaustion while stuck
        pool += (CAR_POOL0 - pool)*(1.0 - math.exp(-trel/TAU_REGEN))
    return times, pools


def mean_kills_window(kd_m, n_copies, n_rep, rng, t_fun=6.0*3600.0):
    """Mean number of successful serial lytic rounds within t_fun."""
    tot = 0
    for _ in range(n_rep):
        tt, _ = serial_killing_timeline(kd_m, n_copies, rng, t_fun=t_fun)
        tot += len(tt)
    return tot/float(n_rep)


def mean_residence_per_target(kd_m, n_copies, n_rep, rng):
    """
    Mean single-target synapse commitment time:
        kill    -> latency + granule + bond-release residence
        no kill -> T_ENC (encounter wasted, cell slides off)
    Returns (mean_time_s, fraction_killed).
    """
    ts = []
    frac = 0
    koff = koff_from_kd(kd_m)
    for _ in range(n_rep):
        n_ag = sample_synapse(n_copies, rng)
        sizes = sample_cluster_sizes(n_ag, rng)
        lat = first_kill_latency(sizes, kd_m)
        if np.isinf(lat):
            ts.append(T_ENC)
        else:
            b = max(1.0, n_ag*p_occ(koff))
            ts.append(lat + TAU_GRAN + release_time(b, kd_m))
            frac += 1
    return float(np.mean(ts)), frac/float(n_rep)


# ======================================================================
# Figures
# ======================================================================
def make_figure_1(kd_range=None, n_range=None, n_rep=25, seed=0, out=None):
    """
    Phase diagram: antigen copy number (y, log) x Kd (x, log); colour = mean
    serial lytic rounds in 6 h (effective output).  Shows the vertical density
    floor (kinetic segregation), an affinity ridge (serial-trigger optimum) and
    suppression at extreme affinity (kinetic trap / exhaustion).
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LogNorm

    if kd_range is None:
        kd_range = np.logspace(-11, -6.0, 14)
    if n_range is None:
        n_range = np.geomspace(100, 10000, 13)

    rng = np.random.default_rng(seed)
    Z = np.zeros((len(n_range), len(kd_range)))
    for i, n in enumerate(n_range):
        for j, kd in enumerate(kd_range):
            Z[i, j] = mean_kills_window(kd, n, n_rep, rng)

    fig, ax = plt.subplots(figsize=(8.4, 5.8))
    ZZ = np.clip(Z, 4e-3, None)
    pc = ax.pcolormesh(kd_range, n_range, ZZ, norm=LogNorm(vmin=ZZ.min(), vmax=ZZ.max()),
                       cmap="inferno", shading="auto")
    ax.set_xscale("log")
    ax.set_yscale("log")
    cb = fig.colorbar(pc, ax=ax)
    cb.set_label("mean serial lytic rounds / 6 h  (effective output)")
    for kd_m, c, ls in [(1e-8, "#1f77b4", "--"), (1e-11, "#d62728", "-")]:
        ax.axvline(kd_m, color=c, ls=ls, lw=1.5, alpha=0.95)
    ax.axhline(500, color="white", ls=":", lw=0.8, alpha=0.5)
    ax.text(1.15e-11, 55, "Kd=1e-11 M", color="#d62728", fontsize=8,
            rotation=90, va="bottom", ha="right")
    ax.text(1.25e-8, 55, "Kd=1e-8 M", color="#1f77b4", fontsize=8,
            rotation=90, va="bottom", ha="right")
    ax.annotate("team claim zone: Kd=1e-11 M, <500 copies/cell",
                xy=(1.35e-11, 180), xytext=(1e-9, 130),
                color="w", fontsize=7.5,
                arrowprops=dict(arrowstyle="->", color="w", lw=0.9))
    ax.set_xlabel("scFv-TAA dissociation constant   Kd  (M)")
    ax.set_ylabel("antigen copy number per tumour cell")
    ax.set_title("Effective signalling-output phase diagram\n"
                 "(critical-local-density floor + serial-trigger ceiling + kinetic trap/exhaustion)")
    ax.grid(True, which="both", ls=":", lw=0.4, alpha=0.4)
    if out:
        fig.savefig(out, dpi=150, bbox_inches="tight")
    return fig


def make_figure_2(n_range=None, n_rep=60, seed=1, out=None):
    """
    (a) single-cell killing residence time (requested "dwell-time" curve),
    (b) iterative killing turnover (mean serial rounds / 6 h),
    (c) serial-killing timelines at 1e4 copies/cell (individual + mean of 30).
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    if n_range is None:
        n_range = np.geomspace(100, 10000, 16)
    rng = np.random.default_rng(seed)
    kd_pairs = [("Kd = 10 nM (reference)", 1e-8, "#1f77b4"),
                ("Kd = 0.01 nM (x1000 aff.)", 1e-11, "#d62728")]
    data_res = {}
    data_kill = {}
    for name, kd, c in kd_pairs:
        res_m, kills_m = [], []
        for n in n_range:
            tm, _fr = mean_residence_per_target(kd, n, n_rep, rng)
            res_m.append(tm)
            kills_m.append(mean_kills_window(kd, n, n_rep, rng))
        data_res[name] = (np.array(res_m), c)
        data_kill[name] = (np.array(kills_m), c)

    fig, (axa, axb, axc) = plt.subplots(1, 3, figsize=(16.2, 4.9))

    # ---- (a) residence ----
    for name, (rm, c) in data_res.items():
        axa.plot(n_range, rm, "-o", ms=3.5, color=c, lw=1.7, label=name)
    axa.set_xscale("log")
    axa.set_ylabel("mean single-target commitment time (s)")
    axa.set_xlabel("antigen copy number per tumour cell")
    axa.set_title("(a)  Single-cell killing residence time")
    axa.legend(fontsize=8)
    axa.grid(True, which="both", ls=":", lw=0.4, alpha=0.5)
    y0, y1 = axa.get_ylim()
    axa.axvspan(100, 700, color="grey", alpha=0.10)
    axa.text(120, y0 + 0.10*(y1-y0),
             "kinetic-segregation\nfloor: no recognition\nat any affinity",
             fontsize=7.5, color="0.25", va="bottom")

    # ---- (b) serial turnover ----
    for name, (km, c) in data_kill.items():
        axb.plot(n_range, km, "-s", ms=3.5, color=c, lw=1.7, label=name)
    axb.set_xscale("log")
    axb.set_ylabel("mean cumulative lytic rounds / 6 h")
    axb.set_xlabel("antigen copy number per tumour cell")
    axb.set_title("(b)  Iterative (serial) killing turnover")
    axb.legend(fontsize=8)
    axb.grid(True, which="both", ls=":", lw=0.4, alpha=0.5)

    # ---- (c) serial timelines ----
    for name, kd, c in kd_pairs:
        for r in range(4):
            tt, _ = serial_killing_timeline(kd, 1e4, rng)
            if tt:
                axc.step(np.array(tt)/60.0, np.arange(1, len(tt)+1),
                         where="post", color=c, lw=0.8, alpha=0.35)
        all_tt = [serial_killing_timeline(kd, 1e4, rng)[0] for _ in range(30)]
        tgrid = np.arange(0, 6*3600, 120.0)
        avg = np.array([np.mean([np.sum(np.array(x) <= ti) for x in all_tt])
                        for ti in tgrid])
        axc.plot(tgrid/60.0, avg, color=c, lw=2.2, label=name)
    axc.set_xlabel("time (min)")
    axc.set_ylabel("cumulative serial kills")
    axc.set_title("(c)  Serial-killing timeline, 10$^4$ copies/cell\n"
                  "(faint: individual cells; thick: mean of 30)")
    axc.legend(fontsize=8)
    axc.grid(True, ls=":", lw=0.4, alpha=0.5)

    fig.tight_layout()
    if out:
        fig.savefig(out, dpi=150, bbox_inches="tight")
    return fig


# ======================================================================
# Console report / verification
# ======================================================================
def console_report():
    rng = np.random.default_rng(42)
    print("="*78)
    print("IMMUNE-SYNAPSE MECHANOBIOLOGY MODEL - quantitative summary")
    print("="*78)
    print("\n[0] Zero-force bond kinetics  (kon = 1e6 M^-1 s^-1)")
    print(f"{'Kd (M)':>12} {'koff (1/s)':>12} {'dwell F=0 (s)':>14} "
          f"{'dwell F=10pN':>13} {'occupancy':>10}")
    for kd in [1e-8, 1e-11, 3e-8, 3e-9, 1e-7, 3e-7, 1e-6]:
        kf = koff_from_kd(kd)
        print(f"{kd:12.1e} {kf:12.2e} {1.0/kf:14.1f} "
              f"{dwell_catch_slip(kd, 10.0):13.1f} {p_occ(kf):10.3f}")

    print("\n[1] CAR 'receptor sink': protected signalling delivered by ONE CAR")
    l10 = car_lifetime_protected(1e-8)
    l01 = car_lifetime_protected(1e-11)
    for kd in [3e-9, 1e-8, 3e-8, 1e-11]:
        print(f"  Kd={kd:9.1e} M : {car_lifetime_protected(kd):8.0f} s")
    print(f"  -> 10 nM CAR recycles ~ {l10/l01:.1f}x more protected signal per CAR "
          f"than the 0.01 nM CAR.")

    print("\n[2] Single-target & serial behaviour (n_rep=40)")
    for n in [500, 1000, 3000, 10000]:
        k10 = mean_kills_window(1e-8, n, 40, rng)
        k01 = mean_kills_window(1e-11, n, 40, rng)
        r10, f10 = mean_residence_per_target(1e-8, n, 40, rng)
        r01, f01 = mean_residence_per_target(1e-11, n, 40, rng)
        print(f"  N={n:>6}: 6h-serial  10nM={k10:.1f}  0.01nM={k01:.1f}   |   "
              f"commitment 10nM={r10:6.0f}s(kill {f10:.2f})  "
              f"0.01nM={r01:6.0f}s(kill {f01:.2f})")

    print("\n[3] KMC (event-driven Gillespie) check of first-kill latency")
    for n in [3000, 10000]:
        parts = []
        for nm, kd in [("10nM", 1e-8), ("0.01nM", 1e-11)]:
            vals = []
            for _ in range(25):
                n_ag = sample_synapse(n, rng)
                sizes = sample_cluster_sizes(n_ag, rng)
                t, _ne = kmc_single_synapse(sizes, kd, rng)
                vals.append(t if t is not None else np.inf)
            fin = [v for v in vals if np.isfinite(v)]
            parts.append(f"{nm} = {np.mean(fin) if fin else np.inf:.0f} s "
                         f"({len(fin)}/{len(vals)})")
        print(f"  N={n}: first-kill latency   " + "   ".join(parts))


# ======================================================================
# main
# ======================================================================
def main(outdir="."):
    import matplotlib
    matplotlib.use("Agg")
    console_report()
    f1 = make_figure_1(out=os.path.join(outdir, "fig1_signal_output_phase_diagram.png"))
    f2 = make_figure_2(out=os.path.join(outdir, "fig2_residence_and_serial_killing.png"))
    print("\nFigures written to:", outdir)
    return 0


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    main(out)
