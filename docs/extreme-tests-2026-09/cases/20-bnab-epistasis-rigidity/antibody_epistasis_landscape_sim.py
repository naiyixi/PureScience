#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
antibody_epistasis_landscape_sim.py
====================================
A mechanistic, reduced-coordinate structural-biophysics engine that probes the
two failure modes hypothesized in the adversarial antibody-design claim:

    "5 independent top-affinity CDR mutations, linearly additive in free energy
     (dG_total = sum dG_i), give picomolar affinity to the wild-type antigen
     AND, because the engineered interface is rigid, broad neutralization of
     ALL future drifted variants."

The engine is deliberately NOT a force-field.  It is a transparent statistical-
thermodynamic toy of the paratope-epitope interface that makes the *qualitative
verdicts* of the review quantitative:

  * each paratope contact lives on a collective CDR "register" coordinate
    (x = CDR-H3 mode, y = CDR-L3 mode).  A residue/contact has a geometric
    tolerance width w; engineered "strong" contacts are DEEP and NARROW
    (w ~ 0.5) whereas the parental antibody's contacts are SHALLOW and WIDE
    (w ~ 1.5).  Narrow wells = rigid paratope, low conformational entropy,
    fragile under epitope drift; wide wells = plastic paratope, induced-fit
    tolerance.
  * the J_ij "epistasis tensor" penalises pairs of *engaged, incompatible*
    engineered residues (adjacent like-charge Args -> electrostatic frustration;
    adjacent bulky hydrophobic bulks -> packing strain).  Because coupling is
    engagement-dependent it does not cancel between free and bound states and
    therefore shows up directly in double-mutant cycles (negative epistasis).
  * epitope drift is a "lineage library": residues mutate along several
    lineages; each mutation shifts the local epitope register and may change
    the residue chemistry (charge loss / charge reversal / steric bulking).
  * binding free energy is computed from the full conformational partition
    function on the 2D register grid:
        dG_bind(g, v) = -kT ln Z_bound(g,v) + kT ln Z_unbound(g)
    so affinity, the bound-ensemble conformational entropy S_conf, the
    enthalpy/entropy decomposition and (via a projected-barrier Kramers
    estimate) the induced-fit reorganisation timescale all come from one
    self-consistent object.

Outputs (written to <outdir>/):
  fig1_energy_landscape.png   conformational energy landscapes E(x,y; genotype,antigen)
  fig2_epistasis_landscape.png single-mutant bars, double-mutant-cycle deviation
                               matrix heatmap, additive-prediction vs actual scatter,
                               best-affinity-vs-mutation-count curve
  fig3_breadth_titers.png      cross-neutralisation potency-drop vs antigenic
                               distance, drop histogram, breadth-retention curves
  fig4_ensemble_rigidity.png   bound-ensemble conformational entropy, enthalpy/
                               entropy decomposition, induced-fit timescale
  summary.json                 key numbers consumed by the written report
  variant_table.csv            per-variant potency table

Usage:
  python3 antibody_epistasis_landscape_sim.py [outdir]
"""

import os
import sys
import json
import itertools

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# =====================================================================
# 1. Global parameters (heuristic; energies in kT, kT = 1)
# =====================================================================
SEED = 20240905
RNG = np.random.default_rng(SEED)

NGRID = 141
XLIM = 6.0
XS = np.linspace(-XLIM, XLIM, NGRID)          # CDR-H3 register coordinate
YS = np.linspace(-XLIM, XLIM, NGRID)          # CDR-L3 register coordinate
XX, YY = np.meshgrid(XS, YS)                  # (G,G)

KAPA = 0.04          # weak generic loop elasticity 0.5*kappa*(x^2+y^2)

# --- geometry tolerances (reduced units) -----------------------------
W_BUR = 1.7          # generic burial / shape-complementarity width (all genotypes)
W_PEN = 0.9          # charge penalty interaction width
W_DES_BY = {"ar": 0.45, "pos": 0.50, "hyd2": 0.70}   # designed contacts (rigid)
W_WT = 1.50          # parental side-chain contact width (plastic)

# --- energetics ------------------------------------------------------
WC_DES = 2.6         # depth scale of a designed specific contact
WC_WT  = 2.0         # depth scale of parental side-chain contact
D_PEN  = 3.0         # desolvation cost of an unsatisfied engineered charge
R_PEN  = 3.8         # like-charge repulsion cost of engineered charge
BSCALE = 1.00        # global burial multiplier (calibrated to ~nM WT affinity)

# contact-site burial depths  (sites 0-4 CDR-H3, sites 5-7 CDR-L3)
B_DEPTH = np.array([1.6, 1.6, 1.6, 1.5, 1.5, 1.4, 1.2, 1.0]) * BSCALE

LOOP = np.array(["H", "H", "H", "H", "H", "L", "L", "L"], dtype=object)  # site loop
N_SITE = len(LOOP)
CAND = [0, 1, 2, 3, 4, 5]                    # sites available for mutation

# residue categories -> features (h,c,ar,p):  hydrophobic, charge, aromatic, polar
FEAT = {
    "ar":   (1,  0, 1, 0),
    "hyd2": (2,  0, 0, 0),
    "hyd1": (1,  0, 0, 0),
    "neg":  (0, -1, 0, 1),
    "pos":  (0,  1, 0, 1),
    "pol":  (0,  0, 0, 1),
}
# burial preserved depending on the epitope residue category (a charged / tiny
# residue buries less well than a large hydrophobic one)
BULK = {"ar": 1.00, "hyd2": 1.00, "hyd1": 0.95, "pol": 0.90, "neg": 0.90, "pos": 0.90}

# parental (WT) paratope residue and designed (maturation) residue per site
PT_WT  = ["pol", "pol", "pol", "hyd1", "hyd1", "pol", "pol", "hyd1"]
PT_DES = ["ar",  "pos", "pos", "hyd2", "hyd2", "hyd2", "pol", "hyd1"]
# engineered 5-point cluster described in the hypothesis:
#   site0 aromatic stacking   (CDR-H3, vs epitope aromatic)
#   site1 Arg salt bridge     (CDR-H3, vs epitope acidic)  \
#   site2 Arg salt bridge     (CDR-H3, vs epitope acidic)  / like-charge pair
#   site3 hydrophobic bulk-up (CDR-H3, vs epitope hydrophobic)  \
#   site4 hydrophobic bulk-up (CDR-H3, vs epitope hydrophobic)  / packing pair
#   site5 hydrophobic filling (CDR-L3, weakly-coupled low-epistasis alternative)
EP_WT = ["ar", "neg", "neg", "hyd2", "hyd2", "hyd1", "pol", "hyd1"]  # WT epitope

# ---- engaged, incompatible engineered pairs -> negative epistasis (J_ij) ----
J_PAIRS = {(1, 2): 3.5, (3, 4): 2.4, (0, 1): 0.6, (2, 3): 0.6}

# global scale of per-site epitope register displacement on drift (antigenic drift
# strong enough that multi-site mutants genuinely escape a parental antibody)
DRIFT_SCALE = 2.4

# ---- epitope drift transition table: (target, weight, register-shift sigma) --
TRANS = {
    "hyd2": [("hyd1", 3, 0.10), ("ar", 2, 0.28), ("pol", 1, 0.45),
             ("pos", 1, 0.50), ("neg", 1, 0.50)],
    "hyd1": [("hyd2", 3, 0.10), ("ar", 1, 0.25), ("pol", 1, 0.40),
             ("pos", 1, 0.50), ("neg", 1, 0.50)],
    "ar":   [("hyd2", 2, 0.28), ("hyd1", 2, 0.25), ("pol", 1, 0.50),
             ("neg", 1, 0.55), ("pos", 1, 0.55)],
    "pol":  [("hyd1", 2, 0.30), ("hyd2", 1, 0.35), ("ar", 1, 0.40),
             ("neg", 1, 0.45), ("pos", 1, 0.45)],
    "neg":  [("pos", 2, 0.60), ("pol", 2, 0.45), ("hyd1", 1, 0.50),
             ("hyd2", 1, 0.55), ("ar", 1, 0.55)],
    "pos":  [("neg", 2, 0.60), ("pol", 2, 0.45), ("hyd1", 1, 0.50),
             ("hyd2", 1, 0.55), ("ar", 1, 0.55)],
}


# =====================================================================
# 2. Elementary functions
# =====================================================================
def chem_score(r, e):
    """Favourable chemical complementarity of paratope residue r with epitope
    residue e (categories, >=0; repulsion handled separately)."""
    h_r, c_r, ar_r, p_r = FEAT[r]
    h_e, c_e, ar_e, p_e = FEAT[e]
    s = 0.0
    if ar_r and ar_e:
        s += 1.2                       # aromatic stacking
    elif ar_r and h_e >= 1:
        s += 0.45                      # aromatic edge / aliphatic packing
    if h_r >= 1 and h_e >= 1 and not (ar_r and ar_e):
        s += 0.40 if (ar_r or ar_e) else 0.60 * min(h_r, h_e)  # buried hydrophobics
    if c_r != 0 and c_e != 0 and c_r * c_e < 0:
        s += 1.35                      # salt bridge
    elif c_r != 0 and c_e == 0 and p_r and p_e:
        s += 0.25                      # charged residue / neutral-polar contact
    elif c_r == 0 and p_r and p_e:
        s += 0.35                      # polar H-bond-like contact
    return s


def loop_coord(i):
    """Register coordinate array for a site (meshgrid) or its scalar name."""
    return XX if LOOP[i] == "H" else YY


def site_terms(mut, ep, reg):
    """Vectorised interaction energy of every site on the (G,G) grid.

    mut : set of mutated candidate sites
    ep  : list of epitope residue categories (length N)
    reg : list of epitope register shifts (length N)
    """
    E = 0.5 * KAPA * (XX**2 + YY**2)                    # elastic paratope hinge
    for i in range(N_SITE):
        U = loop_coord(i)
        r0 = reg[i]
        des = (i in CAND) and (i in mut)
        res = PT_DES[i] if des else PT_WT[i]
        epc = ep[i]
        # generic burial / shape complementarity (broad, follows the epitope)
        bf = BULK[epc]
        E -= (B_DEPTH[i] * bf) * np.exp(-(U - r0) ** 2 / (2 * W_BUR**2))
        # specific side-chain chemistry
        s = chem_score(res, epc)
        if s > 0:
            if des:
                w = W_DES_BY[res]
                E -= (WC_DES * s) * np.exp(-(U - r0) ** 2 / (2 * w**2))
            else:
                E -= (WC_WT * s) * np.exp(-(U - r0) ** 2 / (2 * W_WT**2))
        # penalties paid only by *engineered* charges against a drifted epitope
        if des:
            c_r = FEAT[res][1]
            c_e = FEAT[epc][1]
            if c_r != 0:
                eng = np.exp(-(U - r0) ** 2 / (2 * W_PEN**2))
                if c_e == 0:
                    E += D_PEN * eng          # unsatisfied desolvation
                elif c_e == c_r:
                    E += R_PEN * eng          # like-charge repulsion
    # engagement-weighted incompatible engineered pairs (negative epistasis)
    for (i, j), Jv in J_PAIRS.items():
        if (i in mut) and (j in mut):
            ei = np.exp(-(loop_coord(i) - reg[i]) ** 2 / (2 * W_BUR**2))
            ej = np.exp(-(loop_coord(j) - reg[j]) ** 2 / (2 * W_BUR**2))
            E += Jv * ei * ej
    return E


def energy_at(x, y, mut, ep, reg):
    """Scalar energy at one (x,y) point (used for projected-barrier kinetics)."""
    E = 0.5 * KAPA * (x**2 + y**2)
    for i in range(N_SITE):
        u = x if LOOP[i] == "H" else y
        r0 = reg[i]
        des = (i in CAND) and (i in mut)
        res = PT_DES[i] if des else PT_WT[i]
        epc = ep[i]
        bf = BULK[epc]
        E -= (B_DEPTH[i] * bf) * np.exp(-(u - r0) ** 2 / (2 * W_BUR**2))
        s = chem_score(res, epc)
        if s > 0:
            if des:
                w = W_DES_BY[res]
                E -= (WC_DES * s) * np.exp(-(u - r0) ** 2 / (2 * w**2))
            else:
                E -= (WC_WT * s) * np.exp(-(u - r0) ** 2 / (2 * W_WT**2))
        if des:
            c_r = FEAT[res][1]
            c_e = FEAT[epc][1]
            if c_r != 0:
                eng = np.exp(-(u - r0) ** 2 / (2 * W_PEN**2))
                if c_e == 0:
                    E += D_PEN * eng
                elif c_e == c_r:
                    E += R_PEN * eng
    for (i, j), Jv in J_PAIRS.items():
        if (i in mut) and (j in mut):
            ui = x if LOOP[i] == "H" else y
            uj = x if LOOP[j] == "H" else y
            ei = np.exp(-(ui - reg[i]) ** 2 / (2 * W_BUR**2))
            ej = np.exp(-(uj - reg[j]) ** 2 / (2 * W_BUR**2))
            E += Jv * ei * ej
    return E


# =====================================================================
# 3. Statistical thermodynamics on the register grid
# =====================================================================
def logZ_of(E):
    """ln [ sum_grid exp(-E) ]  (stable)."""
    m = E.min()
    return -m + np.log(np.sum(np.exp(-(E - m))))


def unbound_free_energy(mut):
    """Free energy of the antigen-free antibody (elastic well only)."""
    E = 0.5 * KAPA * (XX**2 + YY**2)
    return -logZ_of(E)


def bound_free_energy(mut, ep, reg):
    """F_b(g,v) = -ln Z_bound over the paratope register ensemble."""
    E = site_terms(mut, ep, reg)
    return -logZ_of(E)


def dG_bind(mut, ep, reg):
    """Binding free energy dG_bind(g,v) = F_b - F_unbound (kT)."""
    return bound_free_energy(mut, ep, reg) - unbound_free_energy(mut)


def bound_ensemble_stats(mut, ep, reg):
    """p over the bound register grid + (mean energy, configurational entropy)."""
    E = site_terms(mut, ep, reg)
    z = logZ_of(E)
    p = np.exp(-(E + z))                # sums to 1
    meanE = float(np.sum(p * E))
    S = float(-np.sum(p * np.log(p + 1e-300)))     # kT=1 -> dimensionless
    return p, meanE, S


def burial_grid(ep, reg):
    """Genotype-independent 'generic docking' energy of antigen v: elastic hinge
    + broad shape-complementarity burial only.  Its low-lying region is the set of
    paratope registers that remain *shape-permissive* for variant v regardless of
    side-chain chemistry."""
    E = 0.5 * KAPA * (XX**2 + YY**2)
    for i in range(N_SITE):
        U = loop_coord(i)
        bf = BULK[ep[i]]
        E -= (B_DEPTH[i] * bf) * np.exp(-(U - reg[i]) ** 2 / (2 * W_BUR**2))
    return E


def unbound_stats():
    E = 0.5 * KAPA * (XX**2 + YY**2)
    z = logZ_of(E)
    p = np.exp(-(E + z))
    meanE = float(np.sum(p * E))
    S = float(-np.sum(p * np.log(p + 1e-300)))
    return p, meanE, S


# ---------------------------------------------------------------------
# Epitope variant generation  ("antigenic-drift lineage library")
# ---------------------------------------------------------------------
WT_EP = list(EP_WT)
WT_REG = [0.0] * N_SITE


def mutation_of(cur):
    opts = TRANS[cur]
    cats = [o[0] for o in opts]
    wts = np.array([o[1] for o in opts], dtype=float)
    sig = [o[2] for o in opts]
    wts /= wts.sum()
    k = int(RNG.choice(len(cats), p=wts))
    return cats[k], sig[k] * DRIFT_SCALE


def make_variant(changes):
    """changes: list of (site, new_cat, reg). Returns (ep, reg)."""
    ep = list(WT_EP)
    reg = [0.0] * N_SITE
    for (i, c, d) in changes:
        ep[i] = c
        reg[i] += d
    return ep, reg


def drift_panel(n_lineage=8, max_depth=4, n_extra=24, extra_depth_max=7):
    """Lineage library + densifying independent drifted variants + engineered
    challenge variants.  Returns list of variant dicts."""
    variants = []

    def add(ep, reg):
        variants.append({"ep": list(ep), "reg": list(reg),
                         "n_mut": sum(1 for a, b in zip(ep, WT_EP) if a != b),
                         "edist": float(np.sqrt(sum(r * r for r in reg))),
                         "label": ""})

    add(WT_EP, WT_REG)                      # wild-type (reference antigen)

    # sequential drift along a few lineages (accumulating mutations)
    for _ in range(n_lineage):
        ep = list(WT_EP)
        reg = [0.0] * N_SITE
        mutated = set()
        depth = int(RNG.integers(1, max_depth + 1))
        for _step in range(depth):
            avail = [i for i in range(N_SITE) if i not in mutated]
            if not avail:
                break
            i = int(RNG.choice(avail))
            newcat, sig = mutation_of(ep[i])
            ep[i] = newcat
            reg[i] += float(RNG.normal(0.0, sig))
            mutated.add(i)
        add(ep, reg)

    # independent variants at various distances
    for _ in range(n_extra):
        k = int(RNG.integers(1, extra_depth_max + 1))
        ep = list(WT_EP)
        reg = [0.0] * N_SITE
        sites = RNG.choice(N_SITE, size=min(k, N_SITE), replace=False)
        for si in sites:
            si = int(si)
            newcat, sig = mutation_of(ep[si])
            ep[si] = newcat
            reg[si] += float(RNG.normal(0.0, sig))
        add(ep, reg)

    # engineered challenges (worst-case drift chemistries)
    for changes in ([(1, "pol", 0.75), (2, "hyd2", 0.90)],  # charge-loss cluster
                    [(1, "pos", 1.00)],                     # charge reversal
                    [(0, "hyd2", 0.80), (4, "ar", 0.80)]):  # steric bulking
        ep, reg = make_variant(changes)
        add(ep, reg)

    # reference antigen first, readable labels on a few early entries
    variants[0]["label"] = "WT"
    out = []
    seen = set()
    for v in variants:
        key = (tuple(v["ep"]), tuple(np.round(v["reg"], 2)))
        if key not in seen:
            seen.add(key)
            out.append(v)
    for idx in (1, 2, 3):
        if idx < len(out):
            out[idx]["label"] = f"l{idx}"
    return out


# =====================================================================
# 4. Experiment runner
# =====================================================================
def all_subgenotypes():
    subs = []
    for k in range(len(CAND) + 1):
        for comb in itertools.combinations(CAND, k):
            subs.append(frozenset(comb))
    return subs


def experiment():
    """Run everything, write figures + summary; return results dict."""
    outdir = sys.argv[1] if len(sys.argv) > 1 else "sim_outputs"
    os.makedirs(outdir, exist_ok=True)
    res = {}

    # ---------- A. single & double-mutant cycles on the WT antigen ----------
    wt_ep, wt_reg = WT_EP, WT_REG
    g0 = frozenset()
    F = {}
    for mut in all_subgenotypes():
        F[mut] = dG_bind(mut, wt_ep, wt_reg)

    singles = {i: F[frozenset([i])] for i in CAND}
    dD_single = {i: singles[i] - F[g0] for i in CAND}     # <0 = favourable
    # double-mutant-cycle deviation  delta_ij = F_ij - F_i - F_j + F_WT
    dev = np.zeros((len(CAND), len(CAND)))
    for a, i in enumerate(CAND):
        for b, j in enumerate(CAND):
            if i == j:
                continue
            bij = frozenset([i, j])
            dev[a, b] = F[bij] - singles[i] - singles[j] + F[g0]

    # greedy "top-5 singles" combo (what the hypothesis prescribes)
    rank = sorted(CAND, key=lambda i: dD_single[i])          # most favourable first
    greedy5 = frozenset(rank[:5])
    # landscape-aware best genotype per cardinality
    best_by_k = {}
    for mut in all_subgenotypes():
        k = len(mut)
        if k not in best_by_k or F[mut] < F[best_by_k[k]]:
            best_by_k[k] = mut
    best5 = best_by_k[5]
    best4 = best_by_k[4]

    pred_add = {mut: F[g0] + sum(dD_single[i] for i in mut) for mut in all_subgenotypes()}
    combo_pred = pred_add[greedy5]
    combo_act = F[greedy5]
    shortfall = combo_act - combo_pred          # >0 => less favourable than additive
    # marginal of every member:  F[greedy5] - F[greedy5 \ {i}];  >0 means that
    # residue *destabilises* the combo when appended to the other four ("avalanche")
    marginal = {i: combo_act - F[greedy5 - {i}] for i in greedy5}
    worst_member = max(marginal, key=marginal.get)
    drop_one_best = min((F[greedy5 - {i}] for i in greedy5))
    better_4mer_exists = drop_one_best < combo_act

    res["singles_kT"] = {f"s{i}": float(dD_single[i]) for i in CAND}
    res["single_rank"] = rank
    res["greedy5"] = sorted(greedy5)
    res["best5"] = sorted(best5)
    res["best4"] = sorted(best4)
    res["F_wt"] = float(F[g0])
    res["dG_wt_greedy5"] = float(combo_act)
    res["additive_pred_greedy5"] = float(combo_pred)
    res["shortfall_kT"] = float(shortfall)
    res["marginal"] = {str(i): float(marginal[i]) for i in greedy5}
    res["worst_member"] = int(worst_member)
    res["better_4mer_exists"] = bool(better_4mer_exists)
    res["best_drop_one_F"] = float(drop_one_best)
    res["dev_matrix"] = dev.tolist()
    res["best_by_k_F"] = {int(k): float(F[best_by_k[k]]) for k in best_by_k}
    res["F_all"] = {f"{''.join(map(str,sorted(m)))}" if m else "wt": float(F[m])
                    for m in all_subgenotypes()}

    print("=== single-mutant dD (kT, <0 favourable) ===")
    for i in CAND:
        print(f"  site {i} ({PT_WT[i]}->{PT_DES[i]})  {dD_single[i]:+.3f}")
    print("  greedy top-5 singles rank:", rank)
    print(f"  greedy5 {sorted(greedy5)}: predicted {combo_pred:+.3f} vs actual {combo_act:+.3f}"
          f"  (shortfall {shortfall:+.3f} kT)")
    print(f"  landscape best5 {sorted(best5)}: {F[best5]:+.3f}")
    print(f"  landscape best4 {sorted(best4)}: {F[best4]:+.3f}")
    print(f"  WT-Ab dG_bind on WT antigen: {F[g0]:+.3f} kT")
    print("  marginal of each greedy5 member (F[5]-F[4\\i], kT):",
          {i: round(marginal[i], 3) for i in greedy5})
    print(f"  -> residue {worst_member} has marginal {marginal[worst_member]:+.3f}; "
          f"a better 4-mer exists: {better_4mer_exists} (best drop-one {drop_one_best:+.3f})")

    # ---------- B. variant panel breadth ----------
    panel = drift_panel()

    def drop_log10(mut, v):
        return (dG_bind(mut, v["ep"], v["reg"]) - dG_bind(mut, wt_ep, wt_reg)) / np.log(10.0)

    genotypes = {"WT-Ab": g0, "Greedy5": greedy5, "Best5": best5}
    table = []
    for gen_name, mut in genotypes.items():
        for j, v in enumerate(panel):
            drop = float(drop_log10(mut, v))
            table.append({"genotype": gen_name, "variant": j, "n_mut": v["n_mut"],
                          "edist": v["edist"], "label": v["label"],
                          "drop_log10": drop})
    res["panel_size"] = len(panel)
    res["variants"] = [{"n_mut": v["n_mut"], "edist": v["edist"], "label": v["label"]}
                       for v in panel]

    # absolute Kd anchored so the WT antibody on the WT antigen is 1 nM
    dG_ref = F[g0]
    res["Kd_anchor"] = float(dG_ref)
    res["Kd_table"] = {}
    for gen_name, mut in genotypes.items():
        res["Kd_table"][gen_name] = {}
        for v in panel:
            dg = dG_bind(mut, v["ep"], v["reg"])
            kd_nm = float(np.exp(dg - dG_ref))
            res["Kd_table"][gen_name][v["label"] or "v"] = kd_nm
    # representative: WT antigen (label WT) + a couple of engineered challenges
    ch_labels = ["", "l1", "l2", "l3"]
    for idx, v in enumerate(panel[:6]):
        print("variant", idx, "n_mut", v["n_mut"], "edist %.2f" % v["edist"], v["label"])

    # per-genotype breadth retention at 10x / 100x of its own WT potency
    breadth = {}
    for gen_name, mut in genotypes.items():
        drops = np.array([drop_log10(mut, v) for v in panel[1:]])
        breadth[gen_name] = {
            "frac_lt_1log": float(np.mean(drops <= 1.0)),
            "frac_lt_2log": float(np.mean(drops <= 2.0)),
            "median_drop": float(np.median(drops)),
            "mean_drop": float(np.mean(drops)),
            "p90_drop": float(np.percentile(drops, 90)),
        }
    res["breadth"] = breadth
    print("breadth:", json.dumps(breadth, indent=1))

    # ---------- C. conformational ensemble / rigidity statistics ----------
    reps = {}
    for v in panel:
        reps[v["label"] or "v"] = v
    demo_variants = []
    for v in panel:
        if v["label"]:
            demo_variants.append(v)
    # choose demo antigens: WT, one representative multi-site drift, challenges
    wt_ant = panel[0]
    cand_d = [v for v in panel if v["n_mut"] >= 2]
    drift_demo = (min(cand_d, key=lambda v: abs(v["edist"] - 1.4)) if cand_d
                  else panel[1])
    # challenges: last three appended entries
    chall = panel[-3:]

    ens = {}
    p_cognate = {}
    for gen_name, mut in genotypes.items():
        p_cog, _, _ = bound_ensemble_stats(mut, wt_ep, wt_reg)
        p_cognate[gen_name] = p_cog
    for gen_name, mut in genotypes.items():
        for tag, v in [("WT-Ag", wt_ant), ("drift", drift_demo)] + \
                      [(f"chal{i}", c) for i, c in enumerate(chall)]:
            p, meanE, S = bound_ensemble_stats(mut, v["ep"], v["reg"])
            # pre-existing-ensemble overlap: fraction of the *cognate* (WT-bound)
            # ensemble that already lies inside the shape-permissive register
            # region of antigen v.  This is the pre-organised conformational
            # tolerance available before any induced-fit strain is paid.
            Bv = burial_grid(v["ep"], v["reg"])
            bmin = Bv.min()
            perm = Bv <= bmin + 2.0
            overlap = float(np.sum(p_cognate[gen_name][perm]))
            ens[f"{gen_name}|{tag}"] = {"S_conf": S, "meanE": meanE,
                                        "N_eff": float(np.exp(S)),
                                        "overlap": overlap}
    pu, meanEu, Su = unbound_stats()
    res["unbound_S"] = Su
    res["ensemble"] = ens
    res["demo_labels"] = {"wt": wt_ant["label"], "drift": drift_demo["label"]}
    print("unbound S_conf =", round(Su, 3))

    # ---------- D. kinetic (Kramers projected-barrier) estimate ----------
    def barrier_time(mut, v):
        """Reorganisation time from the genotype's WT-Ag bound basin to its
        bound basin on variant v along the straight line in register space."""
        m0 = np.unravel_index(np.argmin(site_terms(mut, wt_ep, wt_reg)),
                              XX.shape)
        m1 = np.unravel_index(np.argmin(site_terms(mut, v["ep"], v["reg"])),
                              XX.shape)
        x0, y0 = XS[m0[1]], YS[m0[0]]
        x1, y1 = XS[m1[1]], YS[m1[0]]
        L = np.hypot(x1 - x0, y1 - y0)
        if L < 1e-6:
            return 1.0
        t = np.linspace(0, 1, 201)
        xs = x0 + t * (x1 - x0)
        ys = y0 + t * (y1 - y0)
        Es = np.array([energy_at(xs[k], ys[k], mut, v["ep"], v["reg"]) for k in range(201)])
        Emax = Es.max()
        E0 = energy_at(x0, y0, mut, wt_ep, wt_reg)
        barrier = max(Emax - E0, 0.0)
        tau0 = 1e-11                    # attempt period ~ 10 ps (s)
        return tau0 * np.exp(barrier)   # seconds

    kin = {}
    for gen_name, mut in genotypes.items():
        kin[gen_name] = {}
        for tag, v in [("drift", drift_demo)] + [(f"chal{i}", c) for i, c in enumerate(chall)]:
            kin[gen_name][tag] = float(barrier_time(mut, v))
    res["kinetics_s"] = kin
    print("kinetics (s):", json.dumps({k: {kk: round(vv, 3) for kk, vv in vv.items()}
                                       for k, vv in kin.items()}))

    # =================================================================
    # Figures
    # =================================================================
    fig1 = plot_fig1(genotypes, wt_ant, drift_demo, chall)
    fig1.savefig(os.path.join(outdir, "fig1_energy_landscape.png"), dpi=150,
                 bbox_inches="tight")
    plt.close(fig1)

    fig2 = plot_fig2(CAND, dD_single, dev, F, pred_add, greedy5, best5, best_by_k)
    fig2.savefig(os.path.join(outdir, "fig2_epistasis_landscape.png"), dpi=150,
                 bbox_inches="tight")
    plt.close(fig2)

    fig3 = plot_fig3(panel, genotypes, drop_log10, breadth)
    fig3.savefig(os.path.join(outdir, "fig3_breadth_titers.png"), dpi=150,
                 bbox_inches="tight")
    plt.close(fig3)

    fig4 = plot_fig4(ens, unbound_stats, genotypes, wt_ant, drift_demo, chall, kin)
    fig4.savefig(os.path.join(outdir, "fig4_ensemble_rigidity.png"), dpi=150,
                 bbox_inches="tight")
    plt.close(fig4)

    # ---------- data export ----------
    with open(os.path.join(outdir, "variant_table.csv"), "w") as fh:
        fh.write("genotype,variant,n_mut,edist,label,drop_log10\n")
        for row in table:
            fh.write(f"{row['genotype']},{row['variant']},{row['n_mut']},"
                     f"{row['edist']:.3f},{row['label']},{row['drop_log10']:.4f}\n")
    with open(os.path.join(outdir, "summary.json"), "w") as fh:
        json.dump(res, fh, indent=1)

    print("Figures and summary written to", outdir)
    return res


# =====================================================================
# 5. Plotting
# =====================================================================
_PAL = {"WT-Ab": "#2c7fb8", "Greedy5": "#d7301f", "Best5": "#31a354",
        "ch": "#7f3b08", "pos": "#54278f", "ar": "#08519c", "hyd2": "#993404"}


def _E_plot(mut, v):
    return site_terms(mut, v["ep"], v["reg"])


def plot_fig1(genotypes, wt_ant, drift_demo, chall):
    rows = [("WT-Ab", genotypes["WT-Ab"]), ("Greedy5 combo", genotypes["Greedy5"])]
    cols = [("WT antigen", wt_ant), ("drifted variant", drift_demo),
            ("charge-loss challenge", chall[0])]
    fig, axes = plt.subplots(len(rows), len(cols), figsize=(14, 8.6),
                             constrained_layout=True)
    dG_ref = dG_bind(genotypes["WT-Ab"], wt_ant["ep"], wt_ant["reg"])
    for r, (gname, mut) in enumerate(rows):
        for c, (tname, v) in enumerate(cols):
            ax = axes[r, c]
            E = _E_plot(mut, v)
            lo = E.min()
            lv = np.linspace(lo, lo + 24, 60)
            cf = ax.contourf(XX, YY, np.clip(E, lo, lo + 24), levels=lv,
                             cmap="viridis", extend="max")
            ax.contour(XX, YY, E, levels=np.linspace(lo + 2, lo + 24, 12),
                       colors="white", linewidths=0.4, alpha=0.5)
            mi = np.unravel_index(np.argmin(E), E.shape)
            ax.plot(XS[mi[1]], YS[mi[0]], marker="*", ms=16, color="white",
                    mec="black", mew=0.8, zorder=5)
            dg = dG_bind(mut, v["ep"], v["reg"])
            kd = float(np.exp(dg - dG_ref))        # nM, anchored WT-Ab/WT = 1 nM
            ax.set_title(f"{gname} · {tname}\n"
                         f"$\\Delta G_b$={dg:+.1f} kT  K$_d$≈{kd:.3g} nM", fontsize=9)
            ax.set_xlim(-6, 6)
            ax.set_ylim(-6, 6)
            if c == 0:
                ax.set_ylabel("CDR-L3 register y", fontsize=9)
            if r == len(rows) - 1:
                ax.set_xlabel("CDR-H3 register x", fontsize=9)
            ax.tick_params(labelsize=7)
    fig.colorbar(cf, ax=axes, shrink=0.9, label="E(x,y) / kT")
    fig.suptitle("Conformational energy landscape of the paratope register ensemble "
                 "E(x,y)  —  narrow deep basin (rigid Greedy5) vs broad plastic basin "
                 "(WT-Ab) across antigens", fontsize=11)
    return fig


def plot_fig2(CAND, dD_single, dev, F, pred_add, greedy5, best5, best_by_k):
    fig, axes = plt.subplots(2, 2, figsize=(12.5, 10), constrained_layout=True)
    # a) single-mutant effects
    ax = axes[0, 0]
    names = [f"{PT_WT[i]}$\\to${PT_DES[i]}" for i in CAND]
    cols = [_PAL[PT_DES[i]] for i in CAND]
    ax.bar(range(len(CAND)), [dD_single[i] for i in CAND], color=cols, alpha=0.9)
    ax.axhline(0, color="k", lw=0.6)
    ax.set_xticks(range(len(CAND)))
    ax.set_xticklabels([f"{i}\n{names[i]}" for i in range(len(CAND))], fontsize=7)
    ax.set_ylabel("$\\Delta\\Delta G_i$ / kT")
    ax.set_title("(a) single-mutant binding gains on the WT antigen\n"
                 "(each looks strongly additive-friendly)", fontsize=9)

    # b) double-mutant-cycle deviation matrix (heatmap)
    ax = axes[0, 1]
    D = np.where(np.eye(len(CAND)) == 1, np.nan, dev)
    im = ax.imshow(D, cmap="RdBu_r", vmin=-np.nanmax(np.abs(D)),
                   vmax=np.nanmax(np.abs(D)), aspect="auto")
    ax.set_xticks(range(len(CAND)))
    ax.set_yticks(range(len(CAND)))
    ax.set_xticklabels([f"{i}" for i in CAND], fontsize=8)
    ax.set_yticklabels([f"{i}" for i in CAND], fontsize=8)
    for a in range(len(CAND)):
        for b in range(len(CAND)):
            if a != b:
                ax.text(b, a, f"{dev[a,b]:+.1f}", ha="center", va="center",
                        fontsize=7,
                        color="white" if abs(dev[a,b]) > 0.6*np.nanmax(np.abs(D))
                        else "black")
    ax.set_xlabel("site j (mutated together with i)")
    ax.set_ylabel("site i")
    ax.set_title("(b) double-mutant-cycle deviation $\\delta_{ij}=\\Delta\\Delta\\Delta G_{ij}$ / kT\n"
                 "$>$0 = negative epistasis (double gain < sum of singles)", fontsize=9)
    fig.colorbar(im, ax=ax, shrink=0.8)

    # c) additive prediction vs actual (all 64 genotypes)
    ax = axes[1, 0]
    xs = [pred_add[m] for m in F]
    ys = [F[m] for m in F]
    ax.scatter(xs, ys, s=12, color="#636363", alpha=0.7, label="all 2$^6$ genotypes")
    lim = [min(min(xs), min(ys)) - 1, max(max(xs), max(ys)) + 1]
    ax.plot(lim, lim, "--", color="#969696", lw=1, label="linear additivity")
    for g, col, mk, lab in [(greedy5, _PAL["Greedy5"], "X",
                             "Greedy5 (top-5 singles)"),
                            (best5, _PAL["Best5"], "*", "landscape-best 5")]:
        ax.plot(pred_add[g], F[g], marker=mk, ms=13, color=col, mec="k",
                mew=0.6, ls="none", label=lab)
    ax.plot(pred_add[frozenset()], F[frozenset()], "o", color=_PAL["WT-Ab"],
            ms=8, label="parental WT-Ab")
    ax.plot([lim[0], lim[1]], [lim[0], lim[1]], "--", color="#969696")
    ax.set_xlabel("additive prediction  $\\Delta G_{WT}+\\Sigma\\Delta\\Delta G_i$ / kT")
    ax.set_ylabel("actual  $\\Delta G_b$ / kT")
    ax.legend(fontsize=7, loc="lower right")
    ax.set_title("(c) the additivity illusion: every genotype lies below / right\n"
                 "of the diagonal (non-additive shortfall)", fontsize=9)

    # d) best achievable affinity vs number of mutations
    ax = axes[1, 1]
    ks = sorted(best_by_k)
    ys = [F[best_by_k[k]] for k in ks]
    ax.plot(ks, ys, "-o", color="#2c7fb8", label="best achievable")
    ax.axhline(F[greedy5], color=_PAL["Greedy5"], ls="--", lw=1.2)
    ax.axhline(F[best_by_k[4]], color="#f16913", ls=":", lw=1.2)
    ax.text(5.05, F[greedy5], " Greedy5", color=_PAL["Greedy5"], fontsize=8, va="center")
    ax.text(4.05, F[best_by_k[4]] - 0.5, "best-4", color="#f16913", fontsize=8)
    ax.set_xlabel("number of introduced mutations k")
    ax.set_ylabel("best $\\Delta G_b$ over size-k genotypes / kT")
    ax.set_title("(d) diminishing returns & overshoot: greedy 5-mer is worse\n"
                 "than the landscape-aware best-5 (and near best-4)", fontsize=9)
    return fig


def plot_fig3(panel, genotypes, drop_log10, breadth):
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.6), constrained_layout=True)
    # a) potency drop vs effective drift distance
    ax = axes[0]
    for gen_name, col in [("WT-Ab", _PAL["WT-Ab"]), ("Greedy5", _PAL["Greedy5"]),
                          ("Best5", _PAL["Best5"])]:
        ds = np.array([v["edist"] for v in panel[1:]])
        dr = np.array([drop_log10(genotypes[gen_name], v) for v in panel[1:]])
        # binned medians
        order = np.argsort(ds)
        ax.scatter(ds, dr, s=10, alpha=0.4, color=col)
        bins = np.percentile(ds[order], np.linspace(0, 100, 9))
        xs, ys = [], []
        for a, b in zip(bins[:-1], bins[1:]):
            m = (ds >= a) & (ds <= b)
            if m.sum():
                xs.append(np.median(ds[m]))
                ys.append(np.median(dr[m]))
        ax.plot(xs, ys, "-o", color=col, lw=2, ms=4, label=gen_name)
    for thr in (1, 2):
        ax.axhline(thr, color="0.5", ls=":", lw=0.8)
    ax.text(ax.get_xlim()[1]*0.99, 1.05, "10-fold", fontsize=7, ha="right", color="0.3")
    ax.text(ax.get_xlim()[1]*0.99, 2.05, "100-fold", fontsize=7, ha="right", color="0.3")
    ax.set_xlabel("epitope drift distance $\\sqrt{\\Sigma r_i^2}$")
    ax.set_ylabel("log$_{10}$ potency drop vs own WT titer")
    ax.set_title("(a) cross-neutralisation vs antigenic drift\n"
                 "(WT-Ab decays gently; Greedy5 cliffs)", fontsize=9)
    ax.legend(fontsize=8)

    # b) distribution of potency drops
    ax = axes[1]
    for gen_name, col in [("WT-Ab", _PAL["WT-Ab"]), ("Greedy5", _PAL["Greedy5"]),
                          ("Best5", _PAL["Best5"])]:
        dr = np.array([drop_log10(genotypes[gen_name], v) for v in panel[1:]])
        ax.hist(dr, bins=18, density=True, alpha=0.45, color=col, label=gen_name)
    for thr in (1, 2):
        ax.axvline(thr, color="0.4", ls=":", lw=0.8)
    ax.set_xlabel("log$_{10}$ potency drop vs own WT titer")
    ax.set_ylabel("density")
    ax.set_title("(b) cross-neutralisation titer-drop distribution\n"
                 "(rigid combo is all-or-nothing)", fontsize=9)
    ax.legend(fontsize=8)

    # c) breadth-retention curves
    ax = axes[2]
    T = np.linspace(0, 8, 200)
    for gen_name, col in [("WT-Ab", _PAL["WT-Ab"]), ("Greedy5", _PAL["Greedy5"]),
                          ("Best5", _PAL["Best5"])]:
        dr = np.array([drop_log10(genotypes[gen_name], v) for v in panel[1:]])
        frac = [np.mean(dr <= t) for t in T]
        ax.plot(T, frac, color=col, lw=2, label=gen_name)
    ax.axvline(1, color="0.5", ls=":")
    ax.axvline(2, color="0.5", ls=":")
    ax.set_xlabel("potency-drop tolerance log$_{10}$")
    ax.set_ylabel("fraction of variant panel retained")
    ax.set_title("(c) breadth-retention curves\n"
                 "(fraction of drifted variants still neutralised)", fontsize=9)
    ax.legend(fontsize=8)
    return fig


def marginal_Wx(mut, ep, reg):
    """1-D marginal conformational free energy W(x_H3) = -kT ln P(x) along the
    CDR-H3 register mode (L3 register integrated out), shifted to W_min = 0.
    It is the free-energy distribution over conformational microstates and is the
    direct measure of 'conformational restriction' of a genotype on an antigen."""
    E = site_terms(mut, ep, reg)
    xmin = E.min(axis=0)
    logZx = xmin + np.log(np.sum(np.exp(-(E - xmin)), axis=0))
    Fx = -logZx
    return Fx - Fx.min()


def plot_fig4(ens, unbound, genotypes, wt_ant, drift_demo, chall, kin):
    fig, axes = plt.subplots(2, 2, figsize=(13.5, 9), constrained_layout=True)
    tags = ["WT-Ag", "drift"] + [f"chal{i}" for i in range(len(chall))]
    # a) bound-ensemble conformational entropy across demo antigens
    ax = axes[0, 0]
    xpos = np.arange(len(tags))
    w = 0.36
    for gi, g in enumerate(["WT-Ab", "Greedy5", "Best5"]):
        vals = [ens[f"{g}|{t}"]["S_conf"] for t in tags]
        ax.bar(xpos + (gi - 1) * w, vals, width=w, color=_PAL[g],
               label=g, alpha=0.9)
    ax.set_xticks(xpos)
    ax.set_xticklabels(tags, fontsize=8)
    ax.set_ylabel("bound S$_{conf}$ (nat)")
    ax.set_title("(a) bound-ensemble conformational entropy across antigens\n"
                 "(rigid Greedy5 is permanently frozen: S$_{conf}$ clearly below WT-Ab)",
                 fontsize=9)
    ax.legend(fontsize=7)

    # b) enthalpy / entropy decomposition of WT-Ab -> Greedy5 on each antigen
    ax = axes[0, 1]
    dE, dS = [], []
    for t in tags:
        E_c = ens[f"Greedy5|{t}"]["meanE"]
        E_w = ens[f"WT-Ab|{t}"]["meanE"]
        S_c = ens[f"Greedy5|{t}"]["S_conf"]
        S_w = ens[f"WT-Ab|{t}"]["S_conf"]
        dE.append(E_c - E_w)          # enthalpy-like term
        dS.append(-(S_c - S_w))       # -T*dS term (kT=1)
    x = np.arange(len(tags))
    ax.bar(x - 0.2, dE, width=0.4, color="#31a354", label="$\\Delta\\langle E\\rangle$")
    ax.bar(x + 0.2, dS, width=0.4, color="#8856a7", label="$-\\Delta S_{conf}$")
    ax.axhline(0, color="k", lw=0.6)
    ax.set_xticks(x)
    ax.set_xticklabels(tags, fontsize=8)
    ax.set_ylabel("contribution / kT")
    ax.set_title("(b) WT-Ab $\\to$ Greedy5 (per antigen):\n"
                 "enthalpy gain melts on drift, entropy penalty persists", fontsize=9)
    ax.legend(fontsize=7)

    # c) marginal register free energy W(x_H3) -- conformational restriction
    ax = axes[1, 0]
    for g, col in [("WT-Ab", _PAL["WT-Ab"]), ("Greedy5", _PAL["Greedy5"]),
                   ("Best5", _PAL["Best5"])]:
        W = marginal_Wx(genotypes[g], wt_ant["ep"], wt_ant["reg"])
        ax.plot(XS, W, color=col, lw=2, label=f"{g} on WT-Ag")
        Wc = marginal_Wx(genotypes[g], chall[0]["ep"], chall[0]["reg"])
        ax.plot(XS, Wc, color=col, lw=1.2, ls="--", alpha=0.85,
                label=f"{g} on charge-loss")
    ax.set_xlim(-4, 4)
    ax.set_ylim(0, 14)
    ax.set_xlabel("CDR-H3 register microstate x")
    ax.set_ylabel("W(x) / kT  (min = 0)")
    ax.set_title("(c) free energy across register microstates W(x):\n"
                 "plastic basins broad & shallow; rigid Greedy5 deep+narrow on WT,\n"
                 "then displaced/shallow on the charge-loss variant", fontsize=9)
    ax.legend(fontsize=6.5, loc="upper left")

    # d) effective number of accessible conformational microstates
    ax = axes[1, 1]
    x = np.arange(len(tags))
    for gi, g in enumerate(["WT-Ab", "Greedy5", "Best5"]):
        vals = [ens[f"{g}|{t}"]["N_eff"] for t in tags]
        ax.bar(x + (gi - 1) * 0.36, vals, width=0.36, color=_PAL[g],
               label=g, alpha=0.9)
    ax.set_xticks(x)
    ax.set_xticklabels(tags, fontsize=8)
    ax.set_ylabel("N$_{eff}$ = exp(S$_{conf}$) accessible microstates")
    ax.set_title("(d) effective microstate count (conformational restriction)\n"
                 "~3-fold fewer states for rigid Greedy5 than WT-Ab", fontsize=9)
    ax.legend(fontsize=7)
    return fig


if __name__ == "__main__":
    RESULTS = experiment()
