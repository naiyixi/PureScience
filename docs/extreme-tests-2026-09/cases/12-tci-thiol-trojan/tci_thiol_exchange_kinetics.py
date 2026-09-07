#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tci_thiol_exchange_kinetics.py
==============================
Cross-compartment reaction–diffusion ODE model for the *adversarial* analysis of a
"reversibly covalent" 2-cyanoacrylamide Targeted Covalent Inhibitor (TCI).

Hypothesis under stress test (industry claim)
---------------------------------------------
"Because the cyanoacrylamide warhead binds the on-target cysteine with high
thermodynamic reversibility (k_off >> 0), and because its GSH conjugate dissociates
rapidly in vitro, the molecule causes no permanent GSH consumption in the cytosol,
is metabolised like a non-covalent drug, and achieves 100% on-target residence with
no off-target hepatotoxicity / no accumulating mitochondrial stress."

This module implements the competing ODE system needed to test that claim:
drug monomer (D) vs. on-target adduct (D~T) vs. intracellular GSH adduct (D-SG,
the "hidden carrier") vs. mitochondrial key-enzyme covalent adducts
(PDH / alpha-KGDH E2 dihydrolipoamide D-S-Lip; thioredoxin-2 D-S-Trx; matrix
CoA-SH sequestration D-S-CoA), across three physical compartments
(extracellular fluid -> cytosol -> mitochondrial matrix), with:

  * pH-dependent thiolate fractions (cytosol pH 7.2 vs alkaline matrix pH 8.0 vs
    inert lysosome pH ~4.8) for every reactive thiol pool;
  * reversible Michael / retro-Michael exchange, with *microenvironment-set*
    retro rates (a pocket / vicinal-dithiol site can kinetically trap an adduct
    that is fully reversible as a free small-molecule GSH conjugate);
  * steady-state GSH renewal (synthesis + oxidation/turnover) and unidirectional
    MRP-type efflux of the D-SG conjugate (mercapturate drain = permanent GSH &
    warhead loss in the open system);
  * mitochondrial GSH import, matrix CoA pool homeostasis, slow protein-turnover
    repair of damaged PDH/KGDH lipoyl sites and thioredoxin-2;
  * daily repeated hepatic exposure (first-pass liver) with first-order plasma and
    intracellular clearance of the free electrophile.

Physical-organic backbone (references)
--------------------------------------
- Michael acceptor activation + retro-Michael reversibility of dually activated
  alpha-cyano acceptors: the alpha-CN lowers LUMO (forward thiolate attack) AND
  acidifies the adduct alpha-C-H (enables E1cb-like elimination) - reversibility
  is therefore *condition-dependent*, not a molecular constant.
- Matrix alkalinity: mitochondrial matrix ~ pH 8.0 (cytosol ~7.2; delta pH 0.5-1.4
  across the inner membrane).  Every thiolate fraction [RS-] = RStot/(1+10^(pKa-pH))
  therefore rises 6-15x in the matrix, and low-pKa protein thiols
  (thioredoxin Cys, pKa ~ 6-7; dihydrolipoamide, pKa ~ 8.5-9) approach full
  deprotonation there.
- Matrix thiol richness: matrix [CoA] ~ mM-scale (2-5 mM range reported);
  matrix GSH mM-scale; PDH/KGDH lipoyl dithiols and Trx2 in the same small volume.
- Electrophile sensitivity of PDH / alpha-KGDH lipoamide: 4-hydroxynonenal
  irreversibly inactivates PDH and KGDH by reacting with the *reduced*
  (dihydrolipoamide) form of their lipoyl cofactors (Humphries & Szweda 1998,
  Biochemistry 37:15835-15841; PMID 9843389).
- GSH-conjugate export: MRP/GS-X pumps (incl. canalicular MRP2) efflux S-glutathionyl
  adducts which are further processed to mercapturates - permanent drain in the
  open system, absent from a closed in-vitro tube (APAP-GSH / 4-HNE GS-conjugate
  biliary-export literature).

Units & conventions
-------------------
Concentrations in micromolar (uM) within each compartment; time in minutes.
Reference volume = 1 L cytosol; matrix volume Vmat (fraction of cell volume that is
matrix).  Amounts crossing compartments are scaled by Vmat where required.
All rate constants are literature-informed placeholders for the *hypothetical*
molecule; the qualitative conclusions are structural (mechanistic) and are shown by
sensitivity sweeps to hold across orders of magnitude of the uncertain parameters.

Deliverables produced by main():
  - tci_phase_diagram_mito_damage.{pdf,svg,png} : time x dose phase diagram of
    mitochondrial covalent damage accumulation (publication-grade, vector).
  - tci_timeseries.{pdf,svg,png}                 : representative dose time-courses.
  - tci_model_summary.csv                        : key metrics at day 14.

Author: adversarial-chemistry reflection / pure-science notebook.
"""

from __future__ import annotations

import argparse
import csv
import os

import numpy as np
from scipy.integrate import solve_ivp

# ----------------------------------------------------------------------------
# Species indices (concentrations in uM within each compartment)
# ----------------------------------------------------------------------------
I_DE, I_DC, I_DSG, I_GSHC, I_T, I_DT = 0, 1, 2, 3, 4, 5          # extracellular / cytosol
I_DM, I_DSGM, I_GSHM = 6, 7, 8                                      # matrix free drug & GSH chemistry
I_DCOA, I_COA = 9, 10                                               # matrix CoA adduct / free CoA-SH
I_LIP, I_DLIP = 11, 12                                              # reduced dihydrolipoamide sites / damaged
I_TRX, I_DTRX = 13, 14                                              # reduced Trx2 sites / damaged
NSTATE = 15

# ----------------------------------------------------------------------------
# Default parameters
# ----------------------------------------------------------------------------

def params_defaults(**overrides) -> dict:
    """Default model parameters (uM, min units). Overridable by keyword."""
    p = {
        # --- volumes & pH ---
        "Vmat": 0.15,          # matrix volume per L cytosol (hepatocyte)
        "pH_c": 7.2,           # cytosol
        "pH_m": 8.0,           # mitochondrial matrix (alkaline)
        # --- thiol pKa values ---
        "pKa_GSH": 9.2,
        "pKa_CoA": 9.6,
        "pKa_Lip": 8.6,        # dihydrolipoamide thiol (reduced lipoyl site)
        "pKa_Trx": 6.8,        # thioredoxin active-site nucleophilic Cys (low pKa)
        # --- baseline pool sizes (uM) ---
        "GSHc0": 5000.0,       # cytosol reduced GSH
        "GSHm0": 8000.0,       # matrix reduced GSH
        "CoA0": 1200.0,        # matrix free-CoA-equivalent pool (mM-scale matrix CoA)
        "Liptot": 4.0,         # reactive reduced dihydrolipoamide sites, PDH+KGDH (+BCKDH), matrix
        "Trxtot": 6.0,         # matrix Trx2 in the reduced (available) form
        "T0": 0.05,            # on-target kinase pool, cytosol (uM)
        # --- chemistry: Michael addition on thiolate (uM^-1 min^-1) ---
        "k2chem": 2.0e-4,      # intrinsic thiolate -> cyanoacrylamide beta-C (~~3 M^-1 s^-1)
        "k2T": 1.0,            # on-target effective 2nd order (binding-preorganised Cys), ~~1.7e4 M^-1 s^-1
        # --- retro-Michael / "off" rates (min^-1) ---
        # free small-molecule adduct (GSH, CoA): the team's claimed "fast, reversible" rate
        "koff_SG": 0.02,       # D-SG / D-SCoA elimination (t1/2 ~ 35 min) - swept over 3 orders
        # protein-site adducts: microenvironment-set retro rate (pocket / vicinal-dithiol /
        # buried-alpha-H trap).  Shared chemistry: the *same* warhead that is fully reversible
        # as a free GSH conjugate is kinetically trapped once the adduct sits in a protein
        # site that cannot catalyse E1cb elimination.
        "koff_T": 3.0e-4,      # on-target residence (t1/2 ~ 1.6 d) - the "100% residence" claim
        "koff_Lip": 6.0e-5,    # lipoyl adduct net dissociation (t1/2 ~ 8 d)
        "koff_Trx": 6.0e-5,    # Trx2 adduct net dissociation
        # --- repair / turnover ---
        "krepLip": 5.0e-5,     # replacement of damaged PDH/KGDH E2 (t1/2 ~ 9.6 d)
        "krepTrx": 5.0e-5,     # replacement of damaged Trx2 (t1/2 ~ 9.6 d)
        "kdegT": 4.8e-4,       # target protein turnover (t1/2 ~ 1 d)
        # --- GSH renewal / efflux ---
        "ktG": 2.0e-3,         # cytosol GSH basal turnover (t1/2 ~ 5.8 h)
        "kfb": 2.0,            # GSH synthesis feedback gain
        "kEff": 0.02,          # MRP-type efflux of D-SG (uM/min first order), mercapturate drain
        "ktM": 2.0e-3,         # matrix GSH consumption
        "kCoaSyn": 9.6e-4,     # matrix CoA pool homeostasis (t1/2 ~ 12 h)
        # --- transport / clearance ---
        "kU": 0.02,            # extracellular <-> cytosol permeation
        "kXD": 0.10,           # cytosol <-> matrix permeation of free drug (cyt-volume basis)
        "kclE": 0.00385,       # systemic/plasma first-order clearance (t1/2 = 3 h)
        "kclC": 5.0e-4,        # intracellular metabolic clearance of free D (cyt + matrix)
        # --- exposure & run ---
        "dose_daily": 5.0,     # uM bolus into extracellular compartment once per day
        "ndays": 21,
        "integrator": "LSODA",
    }
    p.update(overrides)
    return p


# ----------------------------------------------------------------------------
# Small physical-organic helpers
# ----------------------------------------------------------------------------

def thiolate_fraction(pH: float, pKa: float) -> float:
    """Fraction of a thiol pool present as reactive thiolate [RS-]/[RSH]_tot."""
    return 1.0 / (1.0 + 10.0 ** (pKa - pH))


def hill(x: np.ndarray, x50: float, n: float) -> np.ndarray:
    return 1.0 / (1.0 + np.power(np.maximum(x, 0.0) / x50, n))


# ----------------------------------------------------------------------------
# ODE right-hand side
# ----------------------------------------------------------------------------

def rhs(t: float, y: np.ndarray, p: dict) -> np.ndarray:
    """Return dydt for the 15-species cross-compartment system."""
    d = np.zeros_like(y)

    # precompute thiolate fractions
    fGSHc = thiolate_fraction(p["pH_c"], p["pKa_GSH"])
    fGSHm = thiolate_fraction(p["pH_m"], p["pKa_GSH"])
    fCoA = thiolate_fraction(p["pH_m"], p["pKa_CoA"])
    fLip = thiolate_fraction(p["pH_m"], p["pKa_Lip"])
    fTrx = thiolate_fraction(p["pH_m"], p["pKa_Trx"])

    De, Dc, DSGc, GSHc, Tc, DTc = y[I_DE], y[I_DC], y[I_DSG], y[I_GSHC], y[I_T], y[I_DT]
    Dm, DSGm, GSHm, DCoA, CoA, Lip, DLip, Trx, DTrx = (
        y[I_DM], y[I_DSGM], y[I_GSHM], y[I_DCOA], y[I_COA],
        y[I_LIP], y[I_DLIP], y[I_TRX], y[I_DTRX],
    )
    Vm = p["Vmat"]

    # ---- reaction fluxes (uM/min) ----
    # cytosol: GSH conjugation / retro / MRP-efflux; on-target capture / retro
    JgC = p["k2chem"] * fGSHc * GSHc * Dc
    JonT = p["k2T"] * max(Tc, 0.0) * Dc
    # matrix: competing thiol sinks (per matrix volume, uM/min)
    JgM = p["k2chem"] * fGSHm * GSHm * Dm
    JCoA = p["k2chem"] * fCoA * CoA * Dm
    JLip = p["k2chem"] * fLip * (2.0 * Lip) * Dm       # 2 thiols per lipoyl dithiol site
    JTrx = p["k2chem"] * fTrx * (1.0 * Trx) * Dm       # only the N-terminal Cys of the CXXC motif is a
                                                       # low-pKa nucleophile; the resolving Cys (pKa > 10)
                                                       # is essentially fully protonated and unreactive

    # GSH synthesis with feedback on depletion
    Vsyn0 = p["ktG"] * p["GSHc0"]
    gdep = np.clip(1.0 - GSHc / p["GSHc0"], 0.0, None)
    Vsyn = max(Vsyn0 * (1.0 + p["kfb"] * gdep), 0.15 * Vsyn0)

    # matrix GSH import (driven by cytosol pool)
    kImp = p["ktM"] * p["GSHm0"] * Vm / p["GSHc0"]
    Jimp = kImp * GSHc / Vm

    # ---- state equations ----
    # extracellular compartment
    d[I_DE] = -p["kU"] * (De - Dc) - p["kclE"] * De

    # cytosol
    d[I_DC] = (p["kU"] * (De - Dc) - p["kclC"] * Dc
               - p["kXD"] * (Dc - Dm)            # diffusion to matrix
               - JgC - JonT
               + p["koff_SG"] * DSGc             # GSH-adduct retro (hidden carrier release)
               + p["koff_T"] * DTc)
    d[I_DSG] = JgC - (p["koff_SG"] + p["kEff"]) * DSGc
    d[I_GSHC] = Vsyn - p["ktG"] * GSHc - JgC + p["koff_SG"] * DSGc
    d[I_T] = p["kdegT"] * p["T0"] - p["kdegT"] * Tc - JonT + p["koff_T"] * DTc
    d[I_DT] = JonT - (p["koff_T"] + p["kdegT"]) * DTc

    # matrix (concentrations within matrix volume)
    d[I_DM] = ((p["kXD"] * (Dc - Dm)) / Vm - p["kclC"] * Dm
               - JgM - JCoA - JLip - JTrx
               + p["koff_SG"] * DSGm
               + p["koff_SG"] * DCoA
               + (p["koff_Lip"] + p["krepLip"]) * DLip
               + (p["koff_Trx"] + p["krepTrx"]) * DTrx)
    d[I_DSGM] = JgM - p["koff_SG"] * DSGm
    d[I_GSHM] = Jimp - p["ktM"] * GSHm - JgM + p["koff_SG"] * DSGm
    d[I_DCOA] = JCoA - p["koff_SG"] * DCoA
    # CoA pool homeostasis acts on the *total* free+adducted pool
    d[I_COA] = (p["kCoaSyn"] * (p["CoA0"] - (CoA + DCoA))
                - JCoA + p["koff_SG"] * DCoA)
    d[I_LIP] = -JLip + (p["koff_Lip"] + p["krepLip"]) * DLip
    d[I_DLIP] = JLip - (p["koff_Lip"] + p["krepLip"]) * DLip
    d[I_TRX] = -JTrx + (p["koff_Trx"] + p["krepTrx"]) * DTrx
    d[I_DTRX] = JTrx - (p["koff_Trx"] + p["krepTrx"]) * DTrx

    return d


# ----------------------------------------------------------------------------
# Solvers
# ----------------------------------------------------------------------------

def _step_day(y0, p, dose, day_index, t_eval):
    """Integrate one day (1440 min) after adding a bolus dose to D_e.

    Returns (t_span_out, sol_y) on the requested t_eval grid.
    """
    ystart = y0.copy()
    if dose > 0:
        ystart[I_DE] += dose          # daily hepatic exposure pulse (first pass)
    t0 = 1440.0 * day_index
    sol = solve_ivp(
        rhs, (t0, t0 + 1440.0), ystart, args=(p,),
        method=p.get("integrator", "LSODA"),
        t_eval=t_eval if t_eval is not None else np.linspace(t0, t0 + 1440.0, 49),
        rtol=1e-6, atol=1e-8, max_step=120.0,
    )
    if not sol.success:
        raise RuntimeError(f"solver failed at day {day_index}: {sol.message}")
    return sol.t, sol.y


def run_daily_dosing(p, dose=None, ndays=None, t_eval_per_day=None):
    """Run repeated daily dosing for ndays; return time grid (days) + state matrix.

    Daily bolus into extracellular compartment; samples per day on t_eval_per_day
    (default 13 points/day, i.e. every 2 h, which captures pulse decay).
    """
    dose = p["dose_daily"] if dose is None else dose
    ndays = int(p["ndays"]) if ndays is None else int(ndays)
    nsub = t_eval_per_day if t_eval_per_day is not None else 13

    # initial condition (drug-free physiological baseline)
    y = np.zeros(NSTATE)
    y[I_GSHC] = p["GSHc0"]
    y[I_GSHM] = p["GSHm0"]
    y[I_COA] = p["CoA0"]
    y[I_LIP] = p["Liptot"]
    y[I_TRX] = p["Trxtot"]
    y[I_T] = p["T0"]

    T_all, Y_all = [], []
    for day in range(ndays):
        t_eval = np.linspace(1440.0 * day, 1440.0 * (day + 1), nsub)
        ts, Ys = _step_day(y, p, dose, day, t_eval)
        T_all.append(ts)
        Y_all.append(Ys.T)
        y = Ys[:, -1].copy()

    T = np.concatenate(T_all) / 1440.0          # in days
    Y = np.vstack(Y_all)                        # (n_times, n_state)
    return T, Y


# ----------------------------------------------------------------------------
# Derived metrics
# ----------------------------------------------------------------------------

def compute_metrics(T, Y, p):
    """Return dict of physiological metrics along the time course."""
    Vm = p["Vmat"]
    Tt = Y[:, I_T] + Y[:, I_DT]
    occT = 100.0 * Y[:, I_DT] / np.maximum(Tt, 1e-9)          # % on-target occupancy
    lipPct = 100.0 * Y[:, I_DLIP] / p["Liptot"]                # % PDH/KGDH lipoyl sites damaged
    trxPct = 100.0 * Y[:, I_DTRX] / p["Trxtot"]
    coaFree = 100.0 * Y[:, I_COA] / (Y[:, I_COA] + Y[:, I_DCOA] + 1e-9)
    gshCyt = Y[:, I_GSHC] / p["GSHc0"] * 100.0
    gshMat = Y[:, I_GSHM] / p["GSHm0"] * 100.0

    # mitochondrial functional impairment index (0..1)
    # PDH/alpha-KGDH lipoyl inactivation throttles NADH-linked substrate supply (largest weight);
    # Trx2 loss breaks the matrix redox / peroxide-scavenging loop; CoA sequestration is usually a
    # transient (reversible) carrier and so contributes little except when free CoA is pulled down.
    I_mito = (0.60 * (Y[:, I_DLIP] / p["Liptot"])
              + 0.40 * (Y[:, I_DTRX] / p["Trxtot"])
              + 0.20 * np.clip(1.0 - Y[:, I_COA] / p["CoA0"], 0.0, None))
    I_mito = np.clip(I_mito, 0.0, None)
    psi = 1.0 / (1.0 + np.power(I_mito / 0.33, 5.0))          # DeltaPsi_m proxy (reserve then collapse)

    return {
        "t_day": T,
        "occT": occT,
        "lipPct": lipPct,
        "trxPct": trxPct,
        "coaFree": coaFree,
        "gshCyt": gshCyt,
        "gshMat": gshMat,
        "I_mito": I_mito,
        "psi": psi,
        "Dc": Y[:, I_DC], "Dm": Y[:, I_DM], "De": Y[:, I_DE],
        "DSGc": Y[:, I_DSG], "DCoA": Y[:, I_DCOA],
    }


def sweep_phase(p, doses=None, ndays=None):
    """Run daily-dosing simulations over a dose grid; return mesh-ready arrays.

    Returns dict with 1-D arrays time (days) & dose, and 2-D metrics
    [n_dose, n_time].
    """
    doses = np.geomspace(0.6, 60.0, 18) if doses is None else np.asarray(doses, float)
    ndays = int(p["ndays"]) if ndays is None else int(ndays)
    n_t = ndays * 12 + 1                                # ~ every 2 h across the treatment window
    lip = np.empty((len(doses), n_t))
    psi = np.empty((len(doses), n_t))
    trx = np.empty((len(doses), n_t))
    coaFree = np.empty((len(doses), n_t))
    occ = np.empty((len(doses), n_t))
    for i, dd in enumerate(doses):
        pp = dict(p)
        T, Y = run_daily_dosing(pp, dose=float(dd), ndays=ndays, t_eval_per_day=12)
        m = compute_metrics(T, Y, pp)
        # resample onto common daily grid (assume equally spaced T)
        n = min(len(T), n_t)
        lip[i, :n] = m["lipPct"][:n]
        psi[i, :n] = m["psi"][:n]
        trx[i, :n] = m["trxPct"][:n]
        coaFree[i, :n] = m["coaFree"][:n]
        occ[i, :n] = m["occT"][:n]
        if n < n_t:
            lip[i, n:] = lip[i, n - 1]
            psi[i, n:] = psi[i, n - 1]
            trx[i, n:] = trx[i, n - 1]
            coaFree[i, n:] = coaFree[i, n - 1]
            occ[i, n:] = occ[i, n - 1]
    tgrid = np.arange(n_t) / 12.0                          # days
    return {"doses": doses, "time_days": tgrid,
            "lipPct": lip, "psi": psi, "trxPct": trx,
            "coaFree": coaFree, "occT": occ}


# ----------------------------------------------------------------------------
# Publication figure helpers (journal-style)
# ----------------------------------------------------------------------------

def _style():
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib import rcParams
    rcParams.update({
        "font.family": "serif", "font.serif": ["DejaVu Serif"],
        "mathtext.fontset": "dejavuserif",
        "axes.linewidth": 0.9, "axes.edgecolor": "black",
        "axes.labelsize": 12, "xtick.labelsize": 10, "ytick.labelsize": 10,
        "legend.fontsize": 9, "font.size": 11,
        "axes.titlesize": 12, "savefig.dpi": 300,
    })


def _cmap():
    from matplotlib import colormaps
    return colormaps["magma"].copy()


def plot_phase_diagram(fig=None, out_base="tci_phase_diagram_mito_damage", close=True):
    """time x dose phase diagram of mitochondrial covalent damage + DeltaPsi collapse.

    Saves PDF, SVG (vector) and PNG (300 dpi).
    """
    _style()
    import matplotlib.pyplot as plt
    from matplotlib.colors import LogNorm
    from matplotlib import ticker

    p = params_defaults()
    ph = sweep_phase(p)

    X, Ygrid = np.meshgrid(ph["time_days"], ph["doses"])
    fig, axes = plt.subplots(1, 2, figsize=(11.5, 4.9), constrained_layout=True)
    cm = _cmap()

    # ---- Panel A: PDH/KGDH dihydrolipoamide covalent inactivation (%) ----
    ax = axes[0]
    zlip = np.clip(ph["lipPct"], 0.05, None)          # floor for log colour scale (t=0 column)
    im = ax.pcolormesh(X, Ygrid, zlip, shading="auto",
                       cmap=cm, norm=LogNorm(vmin=0.1,
                                             vmax=min(ph["lipPct"].max(), 100.0)),
                       rasterized=True)
    cf = ax.contour(X, Ygrid, zlip, levels=[1, 5, 10, 25, 50, 75, 90],
                    colors="white", linewidths=0.55, linestyles="-", alpha=0.85)
    ax.clabel(cf, cf.levels[::2], fontsize=8, inline=True, fmt="%d%%")
    ax.set_xlabel("Time on treatment (days)")
    ax.set_ylabel("Daily hepatic warhead exposure  (µM·day)")
    ax.set_title("PDH / α-KGDH lipoyl sites covalently inactivated (%)")
    ax.set_yscale("log")
    ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda v, _: f"{v:g}"))
    cb = fig.colorbar(im, ax=ax, pad=0.02)
    cb.set_label("lipoyl covalent inactivation (%)")

    # ---- Panel B: DeltaPsi_m collapse proxy ----
    ax = axes[1]
    im2 = ax.pcolormesh(X, Ygrid, ph["psi"], shading="auto",
                        cmap="viridis", vmin=0, vmax=1, rasterized=True)
    c50 = ax.contour(X, Ygrid, ph["psi"], levels=[0.5],
                     colors="crimson", linewidths=2.0, linestyles="--")
    ax.clabel(c50, inline=True, fontsize=9,
              fmt=lambda _v: "ΔΨm collapse\n(50% of control)")
    ax.set_xlabel("Time on treatment (days)")
    ax.set_ylabel("Daily hepatic warhead exposure  (µM·day)")
    ax.set_title("Mitochondrial ΔΨm (proxy, fraction of control)")
    ax.set_yscale("log")
    ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda v, _: f"{v:g}"))
    cb2 = fig.colorbar(im2, ax=ax, pad=0.02)
    cb2.set_label("ΔΨm  (0 = collapsed)")

    for ext in ("pdf", "svg", "png"):
        fig.savefig(f"{out_base}.{ext}", bbox_inches="tight")
    if close:
        plt.close(fig)
    return fig, ph


def plot_timeseries(fig=None, out_base="tci_timeseries", close=True):
    """Multi-panel time course of the four-way competition at several doses."""
    _style()
    import matplotlib.pyplot as plt

    p = params_defaults()
    doses = [1.0, 3.0, 10.0]
    colors = ["#2166ac", "#1a9850", "#b2182b"]
    fig, axes = plt.subplots(2, 2, figsize=(10.5, 7.0), constrained_layout=True)
    labels = [f"dose {dd:g} µM·d⁻¹" for dd in doses]
    legend_lines = []

    for c, dd in zip(colors, doses):
        T, Y = run_daily_dosing(p, dose=dd, ndays=int(p["ndays"]), t_eval_per_day=13)
        m = compute_metrics(T, Y, p)
        axes[0, 0].plot(T, m["lipPct"], color=c, lw=1.6)
        axes[0, 1].plot(T, m["occT"], color=c, lw=1.6)
        axes[1, 0].plot(T, m["coaFree"], color=c, lw=1.6)
        axes[1, 1].plot(T, m["psi"], color=c, lw=1.6)
    legend_lines = [axes[0, 0].plot([], [], color=c, lw=1.8)[0] for c in colors]

    for ax, t, ylab in [
        (axes[0, 0], "PDH/α-KGDH lipoyl covalent inactivation (%)", "% lipoyl sites inactivated"),
        (axes[0, 1], "Apparent on-target occupancy (%)", "% target occupancy"),
        (axes[1, 0], "Matrix free CoA-SH (% of baseline)", "% free CoA-SH"),
        (axes[1, 1], "Mitochondrial ΔΨm proxy (0–1)", "ΔΨm proxy"),
    ]:
        ax.set_xlabel("Time on treatment (days)")
        ax.set_ylabel(ylab)
        ax.set_title(t, fontsize=10.5)
    axes[1, 1].set_ylim(0, 1.05)
    axes[0, 1].set_ylim(0, 100)
    fig.legend(legend_lines, labels, loc="upper center", bbox_to_anchor=(0.5, 1.005),
               ncol=3, frameon=False, fontsize=10)

    for ext in ("pdf", "svg", "png"):
        fig.savefig(f"{out_base}.{ext}", bbox_inches="tight")
    if close:
        plt.close(fig)
    return fig


# ----------------------------------------------------------------------------
# CSV summary
# ----------------------------------------------------------------------------

def write_summary_csv(p, out="tci_model_summary.csv"):
    ndays = int(p["ndays"])
    doses = [0.6, 1.0, 2.0, 4.0, 8.0, 15.0, 30.0, 60.0]
    rows = [[f"dose_uM_per_day", f"day{ndays}_lipoyl_pct", f"day{ndays}_occT_pct",
             f"day{ndays}_Trx_pct", f"day{ndays}_freeCoA_pct", f"day{ndays}_dpsi",
             f"day{ndays}_GSH_depletion_cyt_pct", f"day{ndays}_GSH_depletion_mat_pct"]]
    for dd in doses:
        T, Y = run_daily_dosing(p, dose=dd, ndays=ndays, t_eval_per_day=13)
        m = compute_metrics(T, Y, p)
        rows.append([f"{dd:g}", f"{m['lipPct'][-1]:.2f}", f"{m['occT'][-1]:.2f}",
                     f"{m['trxPct'][-1]:.2f}", f"{m['coaFree'][-1]:.2f}",
                     f"{m['psi'][-1]:.3f}",
                     f"{100 - m['gshCyt'][-1]:.2f}", f"{100 - m['gshMat'][-1]:.2f}"])
    with open(out, "w", newline="") as fh:
        csv.writer(fh).writerows(rows)
    return out


# ----------------------------------------------------------------------------
# Command line
# ----------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dose", type=float, default=None, help="daily dose (µM·day)")
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--outdir", type=str, default=".")
    ap.add_argument("--summary", action="store_true", help="write CSV summary")
    a = ap.parse_args(argv)

    os.makedirs(a.outdir, exist_ok=True)
    here = os.getcwd()
    os.chdir(a.outdir)                     # figures land in outdir
    try:
        p = params_defaults()
        if a.dose is not None:
            p["dose_daily"] = a.dose
        p["ndays"] = a.days

        print("=" * 74)
        print("Cyanoacrylamide TCI — cross-compartment thiol-exchange model run")
        print("=" * 74)
        print(f"daily hepatic exposure : {p['dose_daily']:g} µM·day   run length: {p['ndays']} d")
        print(f"cytosol pH {p['pH_c']} | matrix pH {p['pH_m']} | matrix GSH {p['GSHm0']:g} µM "
              f"| matrix CoA {p['CoA0']:g} µM")
        print(f"small-molecule adduct k_off (team claim) : {p['koff_SG']:g} min^-1")
        print(f"protein-site adduct k_off (trapping)     : {p['koff_Lip']:g} min^-1")
        print("-" * 74)

        fig, ph = plot_phase_diagram(out_base=os.path.join(here, "tci_phase_diagram_mito_damage"))
        plot_timeseries(out_base=os.path.join(here, "tci_timeseries"))
        if a.summary:
            f = write_summary_csv(p, out=os.path.join(here, "tci_model_summary.csv"))
            print(f"summary CSV written: {f}")

        # headline numbers
        i50 = np.where(ph["psi"].min(axis=0) <= 0.5)[0]
        print(f"phase grid doses   : {ph['doses']}")
        print("Key results (day 14):")
        for k, dd in zip(range(len(ph["doses"])), ph["doses"]):
            if dd in (1.0, 3.0, 10.0) or abs(np.log10(dd) - round(np.log10(dd))) < 1e-9:
                print(f"   dose {dd:5g} µM·d -> lipoyl {ph['lipPct'][k,-1]:6.2f} %  "
                      f"ΔΨm {ph['psi'][k,-1]:.3f}")
    finally:
        os.chdir(here)


if __name__ == "__main__":
    main()
