#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rsm_rna_conformation_trap_sim.py
================================================================================
Non-equilibrium RNA-small-molecule "conformational-trap + polyelectrolyte
entropy trap" simulator
--------------------------------------------------------------------------------
Scenario being audited (adversarial drug-design claim)
    A cationic, aromatic-plane-rich peptoid is reported to bind a 45-nt viral
    RNA regulatory motif (dynamic hairpin-triplex + internal loops) with an ITC
    Kd of 0.15 nM (dH < -18 kcal/mol) measured in a LOW-SALT buffer, with a
    fluorescence-polarisation selectivity of >10^4 against a "generic hairpin".

The simulator implements the three mechanistic objections quantitatively:

  (1) Counterion-release / polyelectrolyte (Record-Manning) channel.
      Every RNA phosphate is a Manning-condensed polyanion (xi_ds ~ 5).
      A ligand of effective valence m' that makes m' ion-pair contacts must
      displace ~ m'*psi thermodynamically-associated counterions; hence
          Kd(eff) = Kd(eff_ref) * (eff/eff_ref)^{m'*psi},
      so the sub-nM affinity measured at low salt collapses at
      cytosolic ionic strength.  "eff" = [K+] + gamma*[Mg2+] is the
      monovalent-equivalent counterion concentration (gamma ~ 70 for the
      divalent/condensation weighting).

  (2) Four-state conformational ensemble with ligand-induced misfold trapping.
      U (unfolded)  <->  N (native, translationally active fold)
      U <-> M (misfolded latent, kinetically accessible)
      N + L <-> NL (native-engaged complex, *desired* on-target)
      M + L <-> ML (misfolded dead-end complex, *undesired* trap)
      Because the low-salt ITC / FP assay scores the complex that the ligand
      itself *induces* on a largely unfolded low-salt ensemble (dS_obs < 0,
      i.e. folding-on-binding), the pocket the ligand really fits is the
      misfold M, not the Mg-stabilised native N.  Here Kd(ML) << Kd(NL), so
      the ligand drains the M pool, re-equilibrates N -> M and kinetically
      locks the non-functional state.

  (3) Transcriptome-wide decoy pool (100 host secondary structures).
      Structured host RNA (rRNA/tRNA/lncRNA motifs) presents ~10^2-10^4
      binding sites per target that geometrically mimic an RNA hairpin/loop.
      Even at 10^3-10^5x weaker per-site affinity, the aggregate sink drains
      the free ligand and forces an "on-target fraction" collapse as host RNA
      abundance rises.

Outputs (written to --out, default ./output):
    fig1_ion_release_fraction_phase.png    salt(mM) x T bivariate phase diagram
                                           of the counterion-release share of
                                           binding free energy (target native site)
    fig2_microstate_population_timeseries.png  U/N/M/NL/ML/decoy population time
                                           course on a log-time axis
    fig3_ontarget_fraction_collapse.png    on-target fraction vs host total RNA
                                           abundance, under K+/Mg2+ fluctuation
    rsm_sim_summary.json                   numeric summary of every key result

Author: biophysical review script  |  units: kcal/mol, K, mM, M, s
================================================================================
"""

import os
import json
import sys
import numpy as np

# ------------------------------------------------------------------ constants
R_CAL  = 1.987e-3            # kcal mol^-1 K^-1
T_25   = 298.15              # ITC anchor temperature (K)
T_phys = 310.15              # 37 degC cell temperature (K)

# Manning / empirical structural parameters
L_B_NM = 0.71                # Bjerrum length in water at 25 C (nm)
XI_DS  = (L_B_NM * 10.0) / (30.8 / 22.0)   # dsRNA, A-form 11 bp/turn, 2.8 A/bp
PSI    = 0.80                # adopted thermodynamically-associated fraction per
                             # phosphate for a mixed ss/ds 45-nt motif (psi_ss~0.46
                             # -> psi_ds~0.80; internal loops lower the effective value)
GAMMA  = 70.0                # empirical Mg2+ -> monovalent-equivalence weighting

# ---- counterion / salt model -------------------------------------------------
def eff_mM(K_mM, Mg_mM):
    """Monovalent-equivalent counterion concentration (mM)."""
    return K_mM + GAMMA * Mg_mM

def dg_ion(mprime, T, eff):
    """Counterion-release (ion-atmosphere) free energy, kcal/mol,
    referenced to a 1 M monovalent-equivalent standard state where the
    ion-release bonus vanishes.  eff is in mM."""
    return mprime * PSI * R_CAL * T * np.log(np.clip(eff, 1e-3, None) / 1000.0)

def dg_spec(T, dH, dG298):
    """Non-electrostatic (specific) binding free energy at temperature T."""
    return dH - T * (dH - dG298) / T_25

def kd_from_thermo(dH, dG298, mprime, T, eff):
    """Dissociation constant (M) of a site from its thermodynamic split."""
    g = dg_spec(T, dH, dG298) + dg_ion(mprime, T, eff)
    return float(np.exp(g / (R_CAL * T))), g

# ---- canonical sites ----------------------------------------------------------
# Native site N: anchored so that Kd = 0.15 nM in the low-salt ITC buffer
# (20 mM K, 0.5 mM Mg => eff = 55 mM) at 25 C, with dH_spec = -19 kcal/mol
# (>= reported |dH|; ion term ~enthalpy-free to first order).
Kd_anchor_inv = 0.15e-9
eff_inv  = eff_mM(20.0, 0.5)                       # 55 mM  (in-vitro buffer)
dG_obs_anchor = R_CAL * T_25 * np.log(Kd_anchor_inv)
dG_ion_anchor = dg_ion(5.0, T_25, eff_inv)
dG298_N   = dG_obs_anchor - dG_ion_anchor          # specific part at 298 K
DH_N      = -19.0                                  # kcal/mol
MP_N      = 5.0                                    # effective valence (ion pairs)

# Misfold site M: the pocket the flat-aromatic/cationic design actually fits
# (exposed, rigidified, ligand-stabilised non-native fold).  More negative
# specific enthalpy AND larger entropy penalty (rigidification) than N.
DH_M      = -24.0
dG298_M   = -9.09
MP_M      = 4.0

# ---- RNA folding energetics (U/N/M), 37 C, kcal/mol relative to U ------------
G_N = -6.5                 # native fold strongly favoured
G_M = -4.8                 # misfold latent ~6% of the unliganded ensemble
K0_FOLD = 1.0e6            # attempt frequency (s^-1)
BAR_UN  = 6.0              # U -> N barrier (kcal/mol)
BAR_UM  = 5.0              # U -> M barrier: misfold forms faster (local fold)
K_NM0   = 0.02             # direct N -> M register-slip rate constant (s^-1)

# ---- bimolecular on-rates (M^-1 s^-1) ----------------------------------------
KON_N = 1.0e7              # native pocket: shape-gated but electrostatically steered
KON_M = 3.0e7              # misfold pocket
KON_D = 1.5e7              # decoys

# ---- copy-number / abundance (M) ---------------------------------------------
T_TOT   = 2.0e-8           # viral target motif, ~10^4 copies cell-equivalent
L_TOT   = 2.0e-6           # nominal free-equivalent intracellular ligand dose
N_DECOY = 100              # host "similar secondary structure" decoy pool
ACC     = 0.35             # fraction of each decoy site free (protein/ribosome-occluded)
SEED    = 2026

# ============================================================================
#  Decoy pool generation
# ============================================================================
def build_decoy_pool(n_decoy=N_DECOY, seed=SEED):
    """100 host RNA secondary-structure sites mimicking an RNA hairpin/loop.

    Returns arrays of (accessible concentration at unit abundance, site params).
    Two tiers:
      * 20 'ribosomal/abundant' members (rRNA 23/18S, tRNA motifs): higher
        abundance, tighter median Kd (they are the dangerous mimics);
      * 80 'generic ncRNA' hairpin/loop motifs: lower abundance, weaker median Kd.
    Kd values are drawn log-normal at the reference cell condition (T_phys,
    150 mM K / 1.5 mM Mg) and each site gets its own effective valence m' that
    governs how much tighter it becomes at low salt.
    """
    rng = np.random.default_rng(seed)
    kd_phys   = np.empty(n_decoy)
    mprime    = np.empty(n_decoy)
    r_mM      = np.empty(n_decoy)      # per-site accessible abundance at s=1 (M)

    n_sticky = 20
    # sticky abundant rRNA/tRNA-like tier
    kd_phys[:n_sticky]  = np.exp(rng.normal(np.log(4.0e-7), np.log(3.0), n_sticky))
    mprime[:n_sticky]   = rng.integers(4, 7, n_sticky).astype(float)
    r_mM[:n_sticky]     = np.exp(rng.uniform(np.log(5.0e-7), np.log(2.0e-6), n_sticky))
    # generic ncRNA hairpin/loop tier
    kd_phys[n_sticky:]  = np.exp(rng.normal(np.log(2.0e-6), np.log(4.0), n_decoy - n_sticky))
    mprime[n_sticky:]   = rng.integers(3, 6, n_decoy - n_sticky).astype(float)
    r_mM[n_sticky:]     = np.exp(rng.uniform(np.log(2.0e-9), np.log(3.0e-7), n_decoy - n_sticky))

    # clip unphysical extremes and impose accessibility
    kd_phys = np.clip(kd_phys, 2.0e-8, 5.0e-5)
    r_mM    = np.clip(r_mM, 1.0e-9, 3.0e-6) * ACC

    # express each site as (dH, dG298, mprime) with dH = dG298 (T-independent
    # specific part; decoy binding treated as energy-entropy compensated)
    eff_phys = eff_mM(150.0, 1.5)
    dG298_d  = R_CAL * T_phys * np.log(kd_phys) - dg_ion(mprime, T_phys, eff_phys)
    return r_mM, dG298_d, mprime

# ============================================================================
#  Kinetic model (stiff ODE, integrated with LSODA)
# ============================================================================
def kd_of_site(dH, dG298, mprime, T, eff):
    return kd_from_thermo(dH, dG298, mprime, T, eff)[0]

def build_rate_constants(T, K_mM, Mg_mM, decoy_dG298, decoy_mprime):
    """Fold + bind rate constants at the requested ionic scenario."""
    eff = eff_mM(K_mM, Mg_mM)
    RT  = R_CAL * T
    k = {}

    # folding rates with detailed balance (state free energies G_N, G_M)
    k['k_UN'] = K0_FOLD * np.exp(-BAR_UN / RT)
    k['k_NU'] = k['k_UN'] * np.exp(G_N / RT)
    k['k_UM'] = K0_FOLD * np.exp(-BAR_UM / RT)
    k['k_MU'] = k['k_UM'] * np.exp(G_M / RT)
    k['k_NM'] = K_NM0
    k['k_MN'] = k['k_NM'] * np.exp((G_M - G_N) / RT)      # [N]/[M] at equilibrium

    # binding (native & misfold target sites)
    Kd_N, _   = kd_from_thermo(DH_N, dG298_N, MP_N, T, eff)
    Kd_M, _   = kd_from_thermo(DH_M, dG298_M, MP_M, T, eff)
    k['Kd_N'] = Kd_N
    k['Kd_M'] = Kd_M
    k['kon_N'] = KON_N
    k['koff_N'] = KON_N * Kd_N
    k['kon_M'] = KON_M
    k['koff_M'] = KON_M * Kd_M

    # decoys (dH = dG298 so specific part is T-independent)
    k['Kd_d']  = np.empty(len(decoy_dG298))
    k['koff_d'] = np.empty(len(decoy_dG298))
    for j in range(len(decoy_dG298)):
        kd = kd_of_site(decoy_dG298[j], decoy_dG298[j], decoy_mprime[j], T, eff)
        k['Kd_d'][j] = kd
        k['koff_d'][j] = KON_D * kd
    k['kon_d'] = KON_D
    k['eff'] = eff
    return k

def make_rhs(k, decoy_r, s):
    """Returns RHS function of the ODE for state vector y:

    indices
      0            : U   (unfolded target)
      1            : N   (native free)
      2            : M   (misfold free)
      3            : NL  (native-engaged complex)
      4            : ML  (misfold dead-end complex)
      5            : Lf  (free ligand)
      5+j          : DL_j (decoy j bound)
    """
    kon_N, koff_N = k['kon_N'], k['koff_N']
    kon_M, koff_M = k['kon_M'], k['koff_M']
    kon_d, koff_d = k['kon_d'], k['koff_d']
    kUN, kNU = k['k_UN'], k['k_NU']
    kUM, kMU = k['k_UM'], k['k_MU']
    kNM = k['k_NM']; kMN = k['k_MN']
    nD = len(decoy_r)
    r = decoy_r * s                      # accessible decoy concentration now

    def rhs(t, y):
        U = y[0]; N = y[1]; M = y[2]; NL = y[3]; ML = y[4]; Lf = y[5]
        DL = y[6:]
        dU  = -kUN*U + kNU*N - kUM*U + kMU*M
        dN  =  kUN*U - kNU*N - kNM*N + kMN*M - kon_N*N*Lf + koff_N*NL
        dM  =  kUM*U - kMU*M + kNM*N - kMN*M - kon_M*M*Lf + koff_M*ML
        dNL =  kon_N*N*Lf - koff_N*NL
        dML =  kon_M*M*Lf - koff_M*ML
        dLf = -dNL - dML
        dDL = np.empty(nD)
        for j in range(nD):
            free = r[j] - DL[j]
            flux = kon_d*free*Lf - koff_d[j]*DL[j]
            dDL[j] = flux
            dLf -= flux
        return np.concatenate([[dU, dN, dM, dNL, dML, dLf], dDL])
    return rhs

def integrate(k, decoy_r, s, t_end, start_unfolded=True, t_eval=None):
    """Integrate the kinetic model to time t_end."""
    from scipy.integrate import solve_ivp
    nD = len(decoy_r)
    y0 = np.zeros(6 + nD)
    y0[0] = T_TOT if start_unfolded else 0.0      # U starts full if co-transcriptional
    if not start_unfolded:
        # pre-folded Boltzmann distribution over U/N/M
        G = np.array([0.0, G_N, G_M])
        p = np.exp(-G / (R_CAL * T_phys))
        y0[:3] = p / p.sum() * T_TOT
    y0[5] = L_TOT
    rhs = make_rhs(k, decoy_r, s)
    if t_eval is not None:
        t_eval = np.asarray(t_eval, dtype=float)
        t_eval = t_eval[(t_eval >= 0.0) & (t_eval <= t_end)]
        if len(t_eval) == 0 or t_eval[-1] < t_end:
            t_eval = np.append(t_eval, t_end)
        if len(t_eval) > 1 and t_eval[0] < 1e-12:
            t_eval[0] = 0.0
        t_eval = np.unique(t_eval)
    sol = solve_ivp(rhs, (0.0, t_end), y0, method='LSODA',
                    rtol=1e-5, atol=1e-13,
                    t_eval=t_eval, dense_output=(t_eval is None))
    return sol

def final_state(k, decoy_r, s, t_end):
    sol = integrate(k, decoy_r, s, t_end, start_unfolded=True, t_eval=None)
    return sol.y[:, -1]

def summarize_state(y, decoy_r, s):
    U, N, M, NL, ML, Lf = y[0], y[1], y[2], y[3], y[4], y[5]
    DL = y[6:]
    bound_decoy = DL.sum()
    bound_all   = NL + ML + bound_decoy
    # fraction of BOUND ligand that is on the native viral fold
    f_bound_on_target = NL / max(bound_all, 1e-30)
    # fraction of the administered DOSE on the native viral fold
    f_dose_on_target  = NL / max(Lf + bound_all, 1e-30)
    occ_native      = NL / T_TOT
    occ_misfold     = ML / T_TOT
    target_bound    = (NL + ML) / T_TOT
    return dict(f_bound_on_target=f_bound_on_target, f_dose_on_target=f_dose_on_target,
                occ_native=occ_native, occ_misfold=occ_misfold,
                target_bound=target_bound, NL=NL, ML=ML, Lf=Lf,
                bound_decoy=bound_decoy, N=N, M=M, U=U)

# ============================================================================
#  Figures
# ============================================================================
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

def fig1_phase_diagram(outdir):
    """Counterion-release free-energy fraction f_ion(log[K+], T) for the native
    target site, at two fixed Mg2+ levels; iso-lines of Kd overlaid."""
    Ks = np.logspace(np.log10(8.0), np.log10(400.0), 160)   # mM
    Ts = np.linspace(278.15, 323.15, 140)                   # K
    KK, TT = np.meshgrid(np.log10(Ks), Ts)

    fig, axes = plt.subplots(1, 2, figsize=(13, 5.2), constrained_layout=True)
    for ax, Mg in zip(axes, [0.05, 1.5]):
        f_ion = np.empty_like(KK)
        logKd_nM = np.empty_like(KK)
        for i in range(len(Ts)):
            for j in range(len(Ks)):
                e = eff_mM(Ks[j], Mg)
                gion = dg_ion(MP_N, Ts[i], e)
                gspec = dg_spec(Ts[i], DH_N, dG298_N)
                gobs = gspec + gion
                f_ion[i, j]  = -gion / max(-gobs, 1e-9) if gobs < 0 else np.nan
                kd, _ = kd_from_thermo(DH_N, dG298_N, MP_N, Ts[i], e)
                logKd_nM[i, j] = np.log10(kd * 1e9)
        pc = ax.contourf(10**KK, TT - 273.15, f_ion, levels=np.linspace(0.20, 0.75, 24),
                         cmap='magma', vmin=0.20, vmax=0.75)
        cs = ax.contour(10**KK, TT - 273.15, logKd_nM,
                        levels=[-1.5, -0.5, 0.5, 1.5, 2.5], colors='w', linewidths=0.8)
        ax.clabel(cs, fmt=lambda x: f"{10**x:.1g} nM", fontsize=7)
        ax.set_xscale('log')
        ax.set_xlim(8, 400)
        ax.set_ylim(5, 50)
        ax.set_xlabel(r"$[\mathrm{K}^+]$ / mM")
        ax.set_ylabel(r"T / °C")
        ax.set_title(f"free $[\\mathrm{{Mg}}^{{2+}}]$ = {Mg} mM\n"
                     "$f_{ion}$ (colour); white iso-lines: $K_d$ (nM)")
        ax.axvline(150, color='c', ls='--', lw=1.0, alpha=0.8)
        ax.text(155, 6.5, "cell [K+]", color='c', fontsize=8, rotation=90, va='bottom')
        ax.grid(alpha=0.2)
    cb = fig.colorbar(pc, ax=axes, shrink=0.9)
    cb.set_label(r"$f_{ion}=|\Delta G_{ion}|/|\Delta G_{bind}|$  "
                 "(share of binding free energy from counterion release)")
    fig.suptitle("Counterion-release share $f_{ion}=|\\Delta G_{ion}|/|\\Delta G_{bind}|$ of the residual\n"
                 "binding free energy (cognate native site); white iso-lines = $K_d$. At cytosolic salt the\n"
                 "claimed 0.15 nM erodes ~10$^{2}$-10$^{3}$x and ions still carry ~1/3 of what remains",
                 fontsize=11)
    out = os.path.join(outdir, "fig1_ion_release_fraction_phase.png")
    fig.savefig(out, dpi=150)
    plt.close(fig)
    return out

def fig2_timecourse(outdir):
    """Population dynamics of U/N/M/NL/ML/decoy-bound ligand (log-time)."""
    k = build_rate_constants(T_phys, 150.0, 1.5,
                             decoy_dG298, decoy_mprime)
    t_eval = np.logspace(-6, np.log10(2.0e4), 700)
    sol = integrate(k, decoy_r, 1.0, 2.0e4, start_unfolded=True, t_eval=t_eval)
    t = sol.t
    U, N, M, NL, ML, Lf = sol.y[0], sol.y[1], sol.y[2], sol.y[3], sol.y[4], sol.y[5]
    DL = sol.y[6:].sum(axis=0)

    fig, ax = plt.subplots(1, 3, figsize=(15.5, 4.6), constrained_layout=True)

    # (a) free folding ensemble (fraction of target)
    ax[0].plot(t, N / T_TOT, color='#1f77b4', label='N  native (free)')
    ax[0].plot(t, M / T_TOT, color='#d62728', label='M  misfold (free)')
    ax[0].plot(t, U / T_TOT, color='0.55', ls='--', lw=0.8, label='U  unfolded')
    ax[0].set_xscale('log'); ax[0].set_xlim(t.min(), t.max())
    ax[0].set_ylim(-0.02, 1.02); ax[0].set_ylabel('fraction of target RNA')
    ax[0].set_title('(a) free conformational ensemble')
    ax[0].legend(fontsize=8)

    # (b) engaged complexes (fraction of target)
    ax[1].plot(t, NL / T_TOT, color='#1f77b4', lw=2, label='NL  native-engaged (on-target)')
    ax[1].plot(t, ML / T_TOT, color='#d62728', lw=2, label='ML  misfold dead-end (trap)')
    ax[1].set_xscale('log'); ax[1].set_xlim(t.min(), t.max())
    ax[1].set_ylabel('fraction of target RNA'); ax[1].set_title('(b) target complexes')
    ax[1].legend(fontsize=8); ax[1].set_ylim(0, 1.02)

    # (c) ligand disposition (fraction of total ligand dose)
    ax[2].plot(t, NL / L_TOT, color='#1f77b4', label='on native target (NL)')
    ax[2].plot(t, ML / L_TOT, color='#d62728', label='misfold trap (ML)')
    ax[2].plot(t, DL / L_TOT, color='#2ca02c', label='host decoy pool (sum DL)')
    ax[2].plot(t, Lf / L_TOT, color='#ff7f0e', ls='--', label='free ligand')
    ax[2].set_xscale('log'); ax[2].set_xlim(t.min(), t.max())
    ax[2].set_ylim(-0.02, 1.02); ax[2].set_ylabel('fraction of ligand dose')
    ax[2].set_title('(c) ligand disposition at 150 mM K$^+$ / 1.5 mM Mg$^{2+}$')
    ax[2].legend(fontsize=8)

    for a in ax:
        a.set_xlabel('time / s (log)'); a.grid(alpha=0.25)
    fig.suptitle("Microstate population time course: ligand is soaked up by the host decoy\n"
                 "pool and by the misfolded dead-end, not by the native viral fold",
                 fontsize=11)
    out = os.path.join(outdir, "fig2_microstate_population_timeseries.png")
    fig.savefig(out, dpi=150)
    plt.close(fig)
    return out

def fig3_collapse(outdir):
    """On-target fraction vs host total RNA abundance under K+/Mg2+ fluctuation."""
    scenarios = [
        ("K$^+$ 150 mM, Mg$^{2+}$ 0.8 mM", 150.0, 0.8, '#1f77b4'),
        ("K$^+$ 150 mM, Mg$^{2+}$ 1.5 mM (cytosol)", 150.0, 1.5, '#d62728'),
        ("K$^+$ 150 mM, Mg$^{2+}$ 3.0 mM", 150.0, 3.0, '#2ca02c'),
    ]
    s_grid = np.logspace(-2.5, 2.5, 33)
    t_end = 1.5e4
    fig, ax = plt.subplots(1, 2, figsize=(13, 5.2), constrained_layout=True)
    for lab, K, Mg, col in scenarios:
        k = build_rate_constants(T_phys, K, Mg, decoy_dG298, decoy_mprime)
        f_bound = np.empty_like(s_grid); occ = np.empty_like(s_grid)
        for i, s in enumerate(s_grid):
            y = final_state(k, decoy_r, s, t_end)
            r = summarize_state(y, decoy_r, s)
            f_bound[i] = r['f_bound_on_target']; occ[i] = r['occ_native']
        ax[0].plot(s_grid, f_bound, color=col, lw=2, label=lab)
        ax[1].plot(s_grid, occ, color=col, lw=2, label=lab)
        i0 = int(np.argmin(np.abs(s_grid - 1.0)))
        ax[0].plot(s_grid[i0], f_bound[i0], 'o', color=col)
        ax[0].annotate(f"  s=1: {f_bound[i0]*100:.2f}%", (s_grid[i0], f_bound[i0]),
                       color=col, fontsize=8, va='bottom')
    ax[0].set_xscale('log'); ax[1].set_xscale('log')
    for a in ax:
        a.set_yscale('log'); a.set_xlabel('host RNA abundance (s, × baseline)')
        a.axvline(1.0, color='0.7', ls=':', lw=1)
        a.axhline(0.5, color='0.7', ls=':', lw=1)
        a.grid(alpha=0.25, which='both')
    ax[0].set_ylabel('on-target bound-ligand fraction\nNL / (NL + ML + sum DL)')
    ax[0].set_ylim(1e-6, 1.1); ax[0].set_title('(a) of ligand that is BOUND, '
                                               'fraction on the native viral fold')
    ax[1].set_ylabel('native occupancy  NL / [target]$_0$')
    ax[1].set_ylim(1e-6, 1.1); ax[1].set_title('(b) native functional engagement per target')
    ax[0].legend(fontsize=8); ax[1].legend(fontsize=8)
    fig.suptitle("Effective targeting freedom collapses as host structured RNA abundance rises\n"
                 "(Mg$^{2+}$ fluctuation only shifts the curves; it cannot rescue them)",
                 fontsize=11)
    out = os.path.join(outdir, "fig3_ontarget_fraction_collapse.png")
    fig.savefig(out, dpi=150)
    plt.close(fig)
    return out

# ============================================================================
#  main
# ============================================================================
def main(out="output"):
    os.makedirs(out, exist_ok=True)
    print("=" * 78)
    print(" rsm_rna_conformation_trap_sim.py  — conformational-trap & polyelectrolyte")
    print(" entropy-trap audit of a 'sub-nM, >10^4-selective' cationic RNA binder")
    print("=" * 78)

    # ----- physical audit summary (thermodynamic bookkeeping) -----------------
    eff_inv = eff_mM(20.0, 0.5)
    eff_cell = eff_mM(150.0, 1.5)
    Kd_N_cell, _ = kd_from_thermo(DH_N, dG298_N, MP_N, T_phys, eff_cell)
    Kd_M_cell, _ = kd_from_thermo(DH_M, dG298_M, MP_M, T_phys, eff_cell)
    Kd_M_inv,  _ = kd_from_thermo(DH_M, dG298_M, MP_M, T_25, eff_inv)
    ddG = R_CAL * T_25 * np.log(Kd_N_cell / Kd_anchor_inv)  # note: Kd anchor is at 25C
    # (compare anchor at same T_phys for a fair statement)
    Kd_N_25_cell, _ = kd_from_thermo(DH_N, dG298_N, MP_N, T_25, eff_cell)
    ratio_25 = Kd_N_25_cell / Kd_anchor_inv

    print(f"\n[thermodynamic audit, Record-Manning ion counting]")
    print(f"  Manning xi: dsRNA={XI_DS:.2f};  effective psi (45-nt motif) = {PSI:.2f}")
    print(f"  ITC anchor  Kd = 0.15 nM @ 25 C, eff=[{20} mM K + 70*{0.5} mM Mg]={eff_inv:.0f} mM")
    print(f"              -> dG = {dG_obs_anchor:.2f} kcal/mol;  dH<-18 => dS_obs < -15 cal/mol/K")
    print(f"              -> counterion share of dG in the assay buffer = {-dg_ion(MP_N,T_25,eff_inv)/abs(dG_obs_anchor)*100:.0f}%")
    print(f"  native-site Kd at cell conditions (150/1.5): {Kd_N_cell*1e9:.0f} nM "
          f"@37C / {Kd_N_25_cell*1e9:.0f} nM @25C  (={ratio_25:.0f}x weaker than the claim)")
    print(f"  misfold-site Kd: {Kd_M_cell*1e9:.1f} nM @cell   but  {Kd_M_inv*1e12:.0f} pM in the assay buffer")
    print(f"  => ligand fits the MISFOLD {Kd_N_cell/Kd_M_cell:.0f}x better than the native fold at cell salt;")
    print(f"     the low-salt ITC number is dominated by a ligand-INDUCED (misfolded) complex.")

    # ----- decoy pool ----------------------------------------------------------
    global decoy_r, decoy_dG298, decoy_mprime
    decoy_r, decoy_dG298, decoy_mprime = build_decoy_pool()
    pool_M = decoy_r.sum()
    print(f"\n[host decoy pool]  {len(decoy_r)} species; total accessible site conc "
          f"= {pool_M*1e6:.2f} uM (= {pool_M*1e9:.0f} nM) at s=1")
    decoy_kd_cell = np.array([kd_from_thermo(decoy_dG298[j], decoy_dG298[j],
                                             decoy_mprime[j], T_phys, eff_cell)[0]
                              for j in range(len(decoy_r))])
    print(f"  Kd decoy @cell: median {np.median(decoy_kd_cell)*1e9:.0f} nM;  "
          f"{int(np.sum(decoy_kd_cell < 5e-7))} sites tighter than 500 nM")

    # ----- time course ---------------------------------------------------------
    t0 = 1e-6
    k = build_rate_constants(T_phys, 150.0, 1.5, decoy_dG298, decoy_mprime)
    y_end = final_state(k, decoy_r, 1.0, 2.0e4)
    r_steady = summarize_state(y_end, decoy_r, 1.0)
    print(f"\n[steady state @ s=1, 150 mM K / 1.5 mM Mg, after ~5.6 h]")
    for kk, vv in r_steady.items():
        print(f"  {kk:20s} = {vv:.3e}" if isinstance(vv, float) else f"  {kk} = {vv}")

    # ----- figures -------------------------------------------------------------
    f1 = fig1_phase_diagram(out)
    f2 = fig2_timecourse(out)
    f3 = fig3_collapse(out)
    print(f"\nfigures written:\n  {f1}\n  {f2}\n  {f3}")

    summary = dict(
        xi_dsRNA=XI_DS, psi=PSI,
        Kd_anchor_nM=Kd_anchor_inv*1e9,
        dG_anchor_kcal=dG_obs_anchor,
        ion_share_anchor=-dg_ion(MP_N, T_25, eff_inv)/abs(dG_obs_anchor),
        Kd_native_cell_nM=Kd_N_cell*1e9, Kd_misfold_cell_nM=Kd_M_cell*1e9,
        Kd_native_erosion_fold=ratio_25,
        decoy_species=len(decoy_r),
        decoy_pool_site_conc_nM=pool_M*1e9,
        steady_state=r_steady,
    )
    with open(os.path.join(out, "rsm_sim_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2)
    print(f"\nsummary -> {os.path.join(out, 'rsm_sim_summary.json')}")
    return f1, f2, f3


if __name__ == "__main__":
    # tolerate non-empty sys.argv (e.g. kernel args) — only consume --out=
    _out = "output"
    for _a in sys.argv[1:]:
        if _a.startswith("--out="):
            _out = _a.split("=", 1)[1]
    main(out=_out)
