#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
supramolecular_prodrug_shear_flow_sim.py
=========================================

Adversarial mechanism audit of "tumour in-situ enzymatic self-assembling nano-prodrug
(Peptide–Drug Conjugate, PDC)" claims under REALISTIC tumour interstitial fluid
mechanics.

Claim audited
-------------
   "Monomer prodrug penetrates the tumour by free diffusion, is cleaved by tumour
    esterase/cathepsin, exposes the hydrophobic / beta-sheet core, and self-assembles
    below CAC ~<1 µM into a cross-beta nanofiber network that PHYSICALLY ANCHORS a gel
    inside the tumour; the gel is thermodynamically so stable that it resists
    interstitial-fluid wash-out and lymphatic clearance, raising local tumour retention
    half-life from ~2 h (free drug) to >14 d."

Counter-hypothesis (this code tests)
------------------------------------
   1D fibrillar assemblies are shear-fragile: microvascular/interstitial convective
   shear (γ̇ ≈ 10–1000 s⁻¹) causes tension-induced scission, raises the apparent CAC,
   multiplies reactive ends and triggers an end-depolymerisation cascade once the
   surrounding monomer is convectively depleted (Peclet/Damkoehler regimes Pe>1).

Model / equations implemented
-----------------------------
   * Starling–Brinkman pressure field (spherical, 1D): -(1/r²)d/dr(r² κ/μ dp/dr)
     = Lv(r)(p_cap(t) − Δπ(r) − p) − L_lym(r)p, with pulsatile microvascular drive.
   * Convection–diffusion transport of mobile species (upwind finite-volume).
   * Multi-state self-assembly kinetics (monomer M → activated A → nucleus/mobile
     fibrils T → entrained network S), with power-law nucleation, per-end
     elongation/depolymerisation (CAC), shear-thinning-aware shear-erosion and
     transcapillary + lymphatic clearance of mobile species.
   * 0D length-resolved population-balance master equation
     (elongation / end-depolymerisation / shear scission) for fibril length spectra
     and wash-out cascade.

Outputs
-------
   fig1_pressure_velocity.png      radial IFP & Darcy-velocity profiles
   fig2_fibril_spectra_cascade.png length-distribution spectra + wash-out retention
   fig3_heatmap_retention.png      r–t accumulation heat maps + retention curves

Usage
-----
   python supramolecular_prodrug_shear_flow_sim.py            # full run (~6–9 min)
   python supramolecular_prodrug_shear_flow_sim.py --quick    # CI / smoke (~1 min)
   python supramolecular_prodrug_shear_flow_sim.py --out DIR  # output directory

Requires: numpy, scipy (optional), matplotlib.
Deterministic (no RNG); the full run reproduces the report figures.
"""
import os, sys, time
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import Normalize

# ============================ SI / unit helpers ==============================
mmHg = 133.322  # Pa per mmHg

# ============================ 1. GEOMETRY (radial spherical) ================
R_T    = 5.0e-3    # tumour radius [m]
R_dom  = 12.0e-3   # outer boundary of the normal-tissue shell [m]
Nr     = 200
rf     = np.linspace(0.0, R_dom, Nr + 1)           # faces
rc     = 0.5 * (rf[1:] + rf[:-1])                  # cell centres
dr     = rc[1] - rc[0]
rcell_v = (4.0*np.pi/3.0) * (rf[1:]**3 - rf[:-1]**3)   # shell volumes [m³]
Aface   = 4.0*np.pi * rf**2                            # face areas [m²]
tn  = rc < R_T                                        # tumour mask
tnn = ~tn
iedge = int(tn.sum())                                # index of last tumour cell

# ============================ 2. POROUS-MEDIA / STARLING PARAMS =============
kap_t, kap_n = 4.0e-17, 2.0e-17            # hydraulic permeability [m²] (tumour/normal)
mu_f        = 1.6e-3                      # interstitial fluid viscosity [Pa·s]
Lv_t, Lv_n  = 4.0e-6, 2.0e-7              # Starling filtration coeff [(Pa s)^-1]
Llym_n      = 4.0e-7                      # lymphatic drainage coeff normal tissue
pc_mm       = 24.0                        # mean microvascular pressure [mmHg]
dpi_t, dpi_n= 5.0, 15.0                   # effective oncotic offsets [mmHg]

kap  = np.where(tn, kap_t, kap_n)
Kface = kap / mu_f
Kf    = np.zeros(Nr+1)
Kf[1:-1]   = 0.5*(Kface[1:] + Kface[:-1]); Kf[0] = Kface[0]; Kf[-1] = Kface[-1]
Lv    = np.where(tn, Lv_t, Lv_n)
Llym  = np.where(tn, 0.0, Llym_n)
dpi   = np.where(tn, dpi_t, dpi_n) * mmHg
PC    = pc_mm * mmHg

def starling_drive(t):
    """Pulsatile microvascular pressure: heartbeat + vasomotion + hypertension surges."""
    hb   = 0.16*np.sin(2*np.pi*t/7.0)
    vas  = 0.30*np.exp(-((t % 240.0) - 60.0)**2/(2*45.0**2)) * (np.sin(2*np.pi*t/240.0) > 0)
    surge= 0.40*np.exp(-((t % 3600.0) - 1500.0)**2/(2*200.0**2))
    return PC*(1.0 + hb + 0.5*vas + surge)

def solve_pressure(t):
    """FV elliptic solve of the tumour-interstitial-hypertension problem:
       -(1/r²) d/dr( r² (κ/μ) dp/dr ) = Lv(r)(drive−Δπ−p) − Llym(r) p ,
       Dirichlet p(R_dom)=0, zero flux at r=0.  Returns pressure & Darcy v."""
    drive = starling_drive(t)
    a = np.zeros(Nr); b = np.zeros(Nr); c = np.zeros(Nr); d = np.zeros(Nr)
    for i in range(Nr):
        gL = Kf[i]*Aface[i]/dr; gR = Kf[i+1]*Aface[i+1]/dr
        Sdiag = (Lv[i] + Llym[i]) * rcell_v[i]
        Srhs  = Lv[i]*(drive - dpi[i]) * rcell_v[i]
        if i == 0:
            b[i] = gR + Sdiag; c[i] = -gR; d[i] = Srhs
        elif i == Nr-1:
            a[i] = -gL; b[i] = gL + Sdiag; d[i] = Srhs
        else:
            a[i] = -gL; b[i] = gL + gR + Sdiag; c[i] = -gR; d[i] = Srhs
    # Thomas algorithm
    cp = np.zeros(Nr); dp2 = np.zeros(Nr)
    cp[0] = c[0]/b[0]; dp2[0] = d[0]/b[0]
    for i in range(1, Nr):
        m = b[i] - a[i]*cp[i-1]
        cp[i] = c[i]/m if i < Nr-1 else 0.0
        dp2[i] = (d[i] - a[i]*dp2[i-1])/m
    p = np.zeros(Nr); p[-1] = dp2[-1]
    for i in range(Nr-2, -1, -1):
        p[i] = dp2[i] - cp[i]*p[i+1]
    vf = np.zeros(Nr+1)
    vf[1:-1] = -Kf[1:-1]*(p[1:] - p[:-1])/dr
    vf[-1]   = -Kf[-1]*(0.0 - p[-1])/dr
    return p, vf, 0.5*(vf[:-1] + vf[1:])

# ============================ 3. INTERSTITIAL TRANSPORT =====================
phi     = 0.20                          # interstitial volume fraction
D_M = D_A = 8.0e-11                     # peptide monomer diffusivity [m²/s]
D_T     = 3.0e-12                       # mobile-fibril diffusivity [m²/s]

# ---- self-assembly (per-interstitial-fluid-volume concentrations in µM) ----
kcut_t, kcut_n = 1.2e-3, 4.0e-5         # enzyme activation 1/s (tumour/normal)
kcut = np.where(tn, kcut_t, kcut_n)
k_on  = 2.0                             # per-end elongation (µM·s)^-1  (2e6 M^-1s^-1)
CAC   = 0.05                            # critical assembly concentration [µM]
k_off = k_on * CAC                      # 0.1 s^-1 per free end
n_star = 10.0; s_cap = 1500.0; s_frag = 150.0
s_eff = 5000.0; eps_s = 0.004           # network free-end budget (~buried ends)
nu_n  = 3.0;   C_s = 1.0; k_n0 = 0.3    # nucleation  J = k_n0 ((A−CAC)/C_s)^nu
kero_max, gcut = 1.5e-3, 150.0          # max shear-erosion 1/s, shear threshold
# shear field
l_shear = 5.0e-8
rhot_hot, wd_hot = 22.0, 5.5e-4         # perivascular-rim shear hotspot
hot = 1.0 + rhot_hot*np.exp(-(R_T - rc)/wd_hot)
vasc_t = 0.45 + 0.55*(rc/R_T)           # vascular-density profile (rim-weighted)
gam_pv = 14.0                           # distributed perivascular micro-shear floor
def shear_field(v_Darcy):
    return np.abs(v_Darcy)/phi/l_shear*hot + gam_pv*vasc_t

# mobile-species clearance: transcapillary return-to-blood + lymphatics
kclr_tmax, kclr_n = 1.5e-4, 2.0e-5
kclr = np.where(tn, kclr_tmax*vasc_t, kclr_n)

# ============================ 4. REACTION + TRANSPORT STEP =================
def reaction_step(M, A, QT, NT, S, gam, dt_r):
    """Explicit Euler + instantaneous projections; all arrays shape (Nr,)."""
    sT  = np.where(NT > 1e-9, QT/np.maximum(NT*1e-3, 1e-12), 0.0)
    ET  = np.where(sT >= n_star, 2.0*NT, 0.0)
    ES  = 2.0*eps_s*np.maximum(S, 0.0)/(s_eff*1e-3)
    r_net = k_on*A - k_off
    r_cut = kcut*M
    FT = r_net*ET*1e-3
    FS = r_net*ES*1e-3
    rel = np.maximum((A - CAC)/C_s, 0.0)
    J   = np.where(A > CAC, k_n0*rel**nu_n, 0.0)
    x   = gam/gcut
    kero = kero_max*x*x/(1.0 + x*x)
    Erode = kero*np.maximum(S, 0.0)
    cap = np.where(A > CAC, 2.0*k_on*np.maximum(A, 0.0)/s_cap, 0.0)  # entrapment 1/s
    CapMass = cap*QT; CapNum = cap*NT
    dM  = -r_cut
    dA  =  r_cut - FT - FS - J
    dQT =  FT + J + Erode - CapMass
    dNT =  (1e3*J/n_star) + (1e3*Erode/s_frag) - CapNum
    dS  =  FS + CapMass - Erode
    M  = np.maximum(M  + dt_r*dM , 0.0)
    A  = np.maximum(A  + dt_r*dA , 0.0)
    QT = np.maximum(QT + dt_r*dQT, 0.0)
    NT = np.maximum(NT + dt_r*dNT, 0.0)
    S  = np.maximum(S  + dt_r*dS , 0.0)
    # sub-critical mobile assemblies dissolve fully to monomer
    sT = np.where(NT > 1e-9, QT/np.maximum(NT*1e-3, 1e-12), 0.0)
    sub = (NT > 1e-9) & (sT < n_star)
    A[sub] += QT[sub]; QT[sub] = 0.0; NT[sub] = 0.0
    # numeric guard: cap runaway mobile mean size
    sT = np.where(NT > 1e-9, QT/np.maximum(NT*1e-3, 1e-12), 0.0)
    huge = (NT > 1e-9) & (sT > 5.0*s_cap)
    Qex = np.where(huge, QT - NT*5.0*s_cap*1e-3, 0.0); Qex = np.maximum(Qex, 0.0)
    S += Qex; QT -= Qex; NT = np.maximum(NT - Qex/(5.0*s_cap*1e-3), 0.0)
    return M, A, QT, NT, S

def transport(M, A, QT, NT, vf, dt):
    """Conservative upwind advection + diffusion for mobile fields (per-fluid conc)."""
    def advdiff(c, D):
        dcdr = np.diff(c)/dr
        JLR = np.zeros(Nr+1)
        vpos = vf[1:Nr] >= 0.0
        cu = np.where(vpos, c[:-1], c[1:])
        JLR[1:Nr]  = vf[1:Nr]*cu - D*dcdr
        JLR[Nr]    = vf[Nr]*c[-1]               # open outflow, zero-gradient diffusion
        term = Aface[0:Nr]*JLR[0:Nr] - Aface[1:Nr+1]*JLR[1:Nr+1]
        return c + dt/rcell_v*term
    return advdiff(M, D_M), advdiff(A, D_A), advdiff(QT, D_T), advdiff(NT, D_T)

def vascular_sink(M, A, QT, NT, S, dt):
    g = 1.0/(1.0 + dt*kclr)                     # transcapillary return-to-blood
    return M*g, A*g, QT*g, NT*g, S

def lymph_sink(M, A, QT, NT, S, p, dt):
    kL = Llym*np.maximum(p, 0.0)/phi
    g  = 1.0/(1.0 + dt*kL)
    M  = np.where(tnn, M*g, M); A = np.where(tnn, A*g, A)
    QT = np.where(tnn, QT*g, QT); NT = np.where(tnn, NT*g, NT)
    return M, A, QT, NT, S

def advance(U, dt, t, with_flow, p_stat):
    M, A, QT, NT, S = U
    if with_flow:
        p, vf, vc = solve_pressure(t + 0.5*dt)
        gam = shear_field(vc)
    else:
        p = p_stat; vf = np.zeros(Nr+1); gam = np.zeros(Nr)
    nsub = max(1, int(np.ceil(dt/0.5))); dtr = dt/nsub
    for _ in range(nsub):
        M, A, QT, NT, S = reaction_step(M, A, QT, NT, S, gam, dtr)
    M, A, QT, NT = transport(M, A, QT, NT, vf, dt)
    M, A, QT, NT, S = vascular_sink(M, A, QT, NT, S, dt)
    M, A, QT, NT, S = lymph_sink(M, A, QT, NT, S, p, dt)
    for arr in (M, A, QT, NT, S):
        np.maximum(arr, 0.0, out=arr)
    return [M, A, QT, NT, S]

def initial_state(delta_mm=0.7):
    """Extravasated prodrug depot, penetration-limited (δ=0.7 mm from the margin)."""
    M0 = np.where(tn, 90.0*np.exp(-(R_T - rc)/(delta_mm*1e-3)), 0.0)
    return [M0.copy(), np.zeros(Nr), np.zeros(Nr), np.zeros(Nr), np.zeros(Nr)]

# ============================ 5. 1D SPATIAL SCENARIO ========================
def run_spatial(with_flow, hours, dt, delta_mm=0.7, heat_every=300.0,
                outdir=".", tag="run"):
    """Integrate the reaction–convection–diffusion model; returns dict of arrays."""
    U = initial_state(delta_mm)
    Mt0 = phi*np.sum(U[0]*rcell_v)
    p_stat = solve_pressure(0.0)[0]
    t = 0.0; met = []; heat = []; ne = max(1, int(heat_every/dt))
    nsteps = int(hours*3600.0/dt)
    for step in range(nsteps):
        U = advance(U, dt, t, with_flow, p_stat)
        t += dt
        if step % ne == 0:
            tot = U[0] + U[1] + U[2] + U[4]
            met.append([t,
                        phi*np.sum(tot[tn]*rcell_v[tn])/Mt0,
                        phi*np.sum(U[3][tn]*rcell_v[tn]),        # NT (diag)
                        phi*np.sum(U[4][tn]*rcell_v[tn])/Mt0])   # S gel
            heat.append(tot.copy())
    met = np.array(met); heat = np.array(heat)
    return dict(met=met, heat=heat, U=U, Mt0=Mt0)

# ============================ 6. 0D POPULATION BALANCE ======================
nA_ = 12.0; Mmax = 14000
k_sc0, gcrit = 4.0e-5, 200.0
Lwash = 1000.0          # fibrils shorter than this are convectively mobile & cleared
msize = np.arange(Mmax + 1, dtype=float)

def ksc(gamma):
    x = gamma/gcrit
    return k_sc0*x*x/(1.0 + x*x)

def run_pb(gamma, t_end, dt=0.5, mbar0=6000.0, Q0=10.0, A0=None, beta=0.0,
           nsteps_record=120):
    """0D length-resolved master equation.
       f[m] [nM] aggregate #, A [µM] free monomer; beta = wash-out rate of mobile
       species (monomers + fibrils shorter than Lwash)."""
    nst = int(nA_); f = np.zeros(Mmax + 1)
    f[int(mbar0)] = Q0/(mbar0*1e-3)
    A = A0 if A0 is not None else CAC
    k_sc = ksc(gamma); t = 0.0; step = 0
    every = max(1, int(round(t_end/dt/nsteps_record)))
    rec = []; active = np.arange(nst, Mmax + 1); wc = int(Lwash)
    while t < t_end - 1e-9:
        fa = f[active]; s = fa.sum()
        if s <= 1e-12 and A <= 1e-12:
            break
        df = np.zeros_like(f); dA = 0.0
        # elongation m->m+1 (monomer consumed)
        df[nst+1:] += 2.0*k_on*A*f[nst:Mmax]
        df[nst:]   -= 2.0*k_on*A*f[nst:]
        dA -= 2.0*k_on*A*s*1e-3
        # end dissociation m->m-1 (monomer released to solution); n*-mers dissolve fully
        df[nst:]   -= 2.0*k_off*f[nst:]
        df[nst:Mmax] += 2.0*k_off*f[nst+1:Mmax+1]
        dA += 2.0*k_off*(f[nst+1:].sum()*1e-3) + 2.0*k_off*f[nst]*nst*1e-3
        # shear scission: parent of size j breaks at rate j*k_sc into uniform pieces
        if k_sc > 0 and s > 1e-12:
            h = active*k_sc*f[active]/np.maximum(active - 1, 1)
            suf = np.concatenate([np.cumsum(h[::-1])[::-1], [0.0]])
            gain = np.zeros_like(f); gain[active] = 2.0*suf[1:]
            df += gain
            df[active] -= active*k_sc*f[active]
            dA += (active*k_sc*f[active]*nst*(nst-1)/np.maximum(active-1, 1)).sum()*1e-3
        # convective clearance of mobile species (monomer + short fibrils < Lwash)
        if beta > 0:
            dA -= beta*A
            df[nst:wc] -= beta*f[nst:wc]
        f = np.maximum(f + dt*df, 0.0); A = max(A + dt*dA, 0.0)
        t += dt; step += 1
        if step % every == 0:
            mass = A + (f[active]*active).sum()*1e-3
            rec.append((t, mass, A))
    return np.array(rec), f

# ============================ 7. PLOTTING ===================================
def plot_fig1(path):
    p1, _, vc1 = solve_pressure(0.0)
    p2, _, vc2 = solve_pressure(1500.0)
    Rmm = rc*1e3
    fig, ax = plt.subplots(1, 2, figsize=(8.4, 3.3))
    for a in ax:
        a.axvspan(0, R_T*1e3, color="#4C72B0", alpha=0.07)
        a.axvline(R_T*1e3, color="#4C72B0", ls="--", lw=1)
    ax[0].plot(Rmm, p1/mmHg, lw=2, color="#C44E52", label="IFP (baseline)")
    ax[0].plot(Rmm, p2/mmHg, lw=1.4, color="#E0A458", ls=":", label="IFP (hypertension surge)")
    ax[0].axhline(0, color="k", lw=.6)
    ax[0].set_xlabel("radial position r (mm)"); ax[0].set_ylabel("interstitial fluid pressure (mmHg)")
    ax[0].set_title("(a) Starling–Brinkman pressure field"); ax[0].set_xlim(0, 12)
    ax[0].legend(loc="center right", fontsize=8)
    ax[1].plot(Rmm, vc1*1e6, lw=2, color="#4C72B0", label="|v$_r$| baseline")
    ax[1].plot(Rmm, vc2*1e6, lw=1.4, color="#DD8452", ls=":", label="|v$_r$| surge")
    ax[1].set_xlabel("radial position r (mm)"); ax[1].set_ylabel("radial Darcy velocity |v$_r$| (µm/s)")
    ax[1].set_title("(b) convective outflow field"); ax[1].set_xlim(0, 12)
    ax[1].legend(loc="upper right", fontsize=8)
    for a in ax:
        a.text(0.02, 0.95, "tumour", transform=a.transAxes, fontsize=7.5, color="#4C72B0", va="top")
    plt.tight_layout(); plt.savefig(path, bbox_inches="tight"); plt.close()

def plot_fig2(spec, opn, path):
    gamlist = [0.0, 30.0, 100.0, 300.0, 1000.0]
    cols = {0:"#7F7F7F", 30:"#4C72B0", 100:"#55A868", 300:"#C44E52", 1000:"#8172B3"}
    ms = msize; act = ms[ms >= nA_]
    fig = plt.figure(figsize=(9.0, 3.6))
    ax = fig.add_subplot(121)
    for g in gamlist:
        f = spec[g]; fa = f[ms >= nA_]; pm = fa*act; tot = pm.sum() + 1e-30
        ax.plot(act, pm/tot, lw=1.6, color=cols[g],
                label=("quiescent γ̇=0" if g == 0 else f"γ̇={g:g} s⁻¹"))
    ax.set_xscale("log"); ax.set_yscale("log"); ax.set_xlim(10, 2e4)
    ax.set_xlabel("fibril length m (monomer units)"); ax.set_ylabel("mass fraction m·P(m)")
    ax.set_title("(a) length-distribution spectra after 2 h, closed system")
    ax.legend(fontsize=7.6)
    ax = fig.add_subplot(122)
    for g in gamlist:
        rec = opn[g]; R = rec[:, 1]/10.05; tt = rec[:, 0]/3600
        lab = "washout only (γ̇=0)" if g == 0 else f"γ̇={g:g} s⁻¹ + washout"
        ax.plot(tt, R, lw=1.9, color=cols[g], label=lab)
    ax.plot([0.08, 24], [1, 1], ls="--", color="k", lw=1.2, label="quiescent control (β=0)")
    ax.axvline(12, color="grey", ls=":", lw=1)
    ax.set_xscale("log"); ax.set_xlim(0.1, 24); ax.set_ylim(0, 1.02)
    ax.set_xlabel("time (h)"); ax.set_ylabel("fraction of assembled mass retained R(t)")
    ax.set_title("(b) convective washout + shear: dissolution cascade")
    ax.legend(fontsize=7.6)
    plt.tight_layout(); plt.savefig(path, bbox_inches="tight"); plt.close()

def plot_fig3(F, S, path):
    Fh, Fm = F["heat"], F["met"]; Sh, Sm = S["heat"], S["met"]
    heat_step = 300.0                       # s between heatmap rows (run_spatial default)
    tF = np.arange(Fh.shape[0])*heat_step/3600.0
    tS = np.arange(Sh.shape[0])*heat_step/3600.0
    rshow = rc*1e3
    fig = plt.figure(figsize=(10.5, 7.4))
    gs = fig.add_gridspec(2, 2, height_ratios=[1.15, 1.0], hspace=0.34, wspace=0.20)
    cmin, cmax = -1.0, 1.6
    def heat(ax, t, data, title, tmax_h=None):
        nsel = min(len(t), len(data))
        if tmax_h is not None:
            nsel = min(nsel, int(np.searchsorted(t, tmax_h)))
        tsel = t[:nsel]; d = data[:nsel]
        Tgrid, Rgrid = np.meshgrid(rshow, tsel)
        v = np.log10(np.clip(d, 1e-1, None))
        pc = ax.pcolormesh(Rgrid, Tgrid, v, cmap="viridis", vmin=cmin, vmax=cmax, shading="auto")
        ax.axvline(5.0, color="white", ls="--", lw=1); ax.axvline(7.0, color="white", ls=":", lw=.8)
        ax.set_xlim(0, 12); ax.set_title(title, fontsize=10)
        return pc
    ax = fig.add_subplot(gs[0, 0]); heat(ax, tF, Fh, "(a)  CONVECTIVE + SHEAR environment (0–48 h)")
    ax.set_ylabel("time (h)")
    ax = fig.add_subplot(gs[0, 1]); heat(ax, tS, Sh, "(b)  QUIESCENT control (0–72 h)", tmax_h=72.0)
    ax.set_ylabel("time (h)")
    fig.colorbar(plt.cm.ScalarMappable(norm=Normalize(cmin, cmax), cmap="viridis"),
                 ax=[fig.axes[0], fig.axes[1]], label="log$_{10}$ total drug concentration (µM)", shrink=0.8)
    ax = fig.add_subplot(gs[1, :])
    ax.plot(Fm[:, 0]/3600, Fm[:, 1], lw=2, color="#C44E52", label="convective-shear interstitium (flow)")
    ax.plot(Fm[:, 0]/3600, Fm[:, 3], lw=1.2, color="#E0A458", ls="--", label="   of which: intact network gel")
    ax.plot(Sm[:, 0]/3600, Sm[:, 1], lw=2.2, color="#4C72B0", label="quiescent control (static)")
    ax.plot(Sm[:, 0]/3600, Sm[:, 3], lw=1.2, color="#7FB3D8", ls="--", label="   of which: intact network gel")
    ax.axvline(12, color="k", ls=":", lw=1); ax.text(13, 0.96, "12 h", fontsize=9)
    ax.axvline(14*24, color="#4C72B0", ls=":", lw=1); ax.text(14*24 + 4, 0.96, "14 d", fontsize=9, color="#4C72B0")
    ax.set_xscale("log"); ax.set_xlim(0.2, 340); ax.set_ylim(0, 1.03)
    ax.set_xticks([0.2, 1, 3, 6, 12, 24, 72, 168, 336])
    ax.set_xticklabels(["0.2", "1", "3", "6", "12", "24", "72", "168", "336"])
    ax.set_xlabel("time (h)"); ax.set_ylabel("tumour-region drug retention R(t) (fraction of deposited dose)")
    ax.set_title("(c) tumour-region retention: advertised 14-day depot collapses within ~12 h under real interstitial flow")
    ax.legend(fontsize=8.5, loc="upper right")
    plt.tight_layout(); plt.savefig(path, bbox_inches="tight"); plt.close()

# ============================ 8. MAIN =======================================
def main(quick=False, outdir="."):
    os.makedirs(outdir, exist_ok=True)
    t_start = time.time()

    # -------- 1D spatial scenarios --------
    p0, _, _ = solve_pressure(0.0)
    print(f"[1D] IFP plateau = {p0[tn].max()/mmHg:.1f} mmHg, "
          f"rim Darcy v = {abs(solve_pressure(0.0)[1][iedge])*1e6:.2f} µm/s")

    if quick:
        F = run_spatial(True,  8.0, 2.0, outdir=outdir, tag="F")
        S = run_spatial(False, 6.0, 4.0, outdir=outdir, tag="S")
    else:
        F = run_spatial(True,  48.0, 2.0, outdir=outdir, tag="F")
        S = run_spatial(False, 14*24.0, 4.0, outdir=outdir, tag="S")
    print(f"[1D] flow  R12h/end = {F['met'][min(np.argmin(abs(F['met'][:,0]-12*3600)), len(F['met'])-1),1]:.3f}/{F['met'][-1,1]:.3f}")
    print(f"[1D] static R(14d)  = {S['met'][-1,1]:.3f}")

    # -------- 0D population balance --------
    gamlist = [0.0, 30.0, 100.0, 300.0, 1000.0]
    spec = {}; opn = {}
    for g in gamlist:                       # closed spectra (no washout)
        _, f = run_pb(g, 2*3600.0, dt=1.0, nsteps_record=4)
        spec[g] = f
    print("[0D] closed spectra done")
    # open (wash-out) retention
    for g in gamlist:
        dtg = 2.0 if g == 0 else (0.5 if g >= 1000 else 1.0)
        tg  = 24*3600.0 if g <= 100 else 12*3600.0
        rec, _ = run_pb(g, tg, dt=dtg, beta=2.0e-4, nsteps_record=160)
        opn[g] = rec
    print("[0D] open wash-out done")

    # -------- figures --------
    plot_fig1(os.path.join(outdir, "fig1_pressure_velocity.png"))
    plot_fig2(spec, opn, os.path.join(outdir, "fig2_fibril_spectra_cascade.png"))
    plot_fig3(F, S, os.path.join(outdir, "fig3_heatmap_retention.png"))
    print(f"[done] figures written to '{outdir}' in {time.time()-t_start:.0f} s")

if __name__ == "__main__":
    quick = "--quick" in sys.argv
    outdir = "."
    if "--out" in sys.argv:
        outdir = sys.argv[sys.argv.index("--out") + 1]
    main(quick=quick, outdir=outdir)
