#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
adc_multiscale_biotransport_barrier_sim.py
===========================================

Multiscale reaction-diffusion(-convection) continuum solver for the
"binding-site-barrier + vascular self-sabotage" hypothesis of ultra-high
affinity (pM) heavy-load ADCs in dense solid tumours.

Geometry : 1-D Krogh cylinder. A single perfused capillary (radius a = 10 um)
exchanges drug with a tissue annulus extending x = 0..300 um from the wall.
All concentrations are per unit *tissue* volume in uM.

Species (per tissue volume, uM unless stated)
   F    free interstitial ADC
   Ag   unbound cell-surface antigen pool
   Ab   antigen-bound ADC
   Abi  internalized ADC
   Pay  free membrane-permeable payload in the interstitium (bystander pool)
   q    accumulated intracellular active payload per surviving cell (molecules/cell)
   v,n  viable / necrotic cell fractions

Governing equations (symbols in the companion report):
   dF/dt   = div(D_F grad F) - div(u F) - k_on F Ag + k_off Ab - k_lF F
   dAg/dt  = -k_on F Ag + k_off Ab - k_int Ab + k_end (Ag0 v - Ag)
   dAb/dt  =  k_on F Ag - (k_off + k_int) Ab
   dAbi/dt =  k_int Ab - k_rel Abi
   dPay/dt =  div(D_P grad Pay) - div(u Pay) + 8 f_leak k_rel Abi
              - (k_lP + k_up v) Pay
   dq/dt   = k_rel Abi (1-f_leak) 8 MOL_UMM + k_up v Pay MOL_UMM - k_rep q
   dv/dt   = -k_kill Hill(q) v            (dn/dt = -dv/dt)

Vessel / tissue damage : the perivascular necrotic burden Rnc(t) in the
0..20 um ring closes the microvessel (P_intra = Pbase / (1+(Rnc/Rh)^s)),
which chokes trans-wall drug influx; residual ring damage lowers Pbase for
subsequent rounds (microthrombosis + perivascular fibrosis).

Advection : small outward Starling interstitial drift. In the Krogh cylinder
the conserved area-velocity product is g = w0 P_intra a (constant).

Usage
-----
    python adc_multiscale_biotransport_barrier_sim.py --case high [--outdir .] [--smoke]
    python adc_multiscale_biotransport_barrier_sim.py --case med  [--outdir .] [--smoke]
"""
from __future__ import annotations
import os
import numpy as np

# --------------------------------------------------------------------------
# physical / pharmacological defaults
# --------------------------------------------------------------------------
MOL_UMM = 6.022e23 / 3.0e11 * 1e-6      # molecules/cell/uM-tissue  (~2.0e6)

DEFAULTS = dict(
    a=10.0, L=300.0, N=80,                      # geometry (um)
    D_ADC=3.0, D_PAY=8.0,                       # effective diffusivities (um^2/s)
    w0=0.05,                                    # Starling drift at wall (um/s)
    P_vas=4.0e-3,                               # trans-vessel ADC permeability (um/s)
    P_pay_wall=1.5,                             # payload wash-out at wall (um/s)
    D_nec=1.6,                                  # necrotic-compaction exponent
    kon=1.0e5,                                  # association (/M/s)
    k_int=2.0e-4, k_end=3.0e-5,                 # internalization & antigen maintenance (/s)
    k_rel=1.0e-4,                               # payload processing (/s)
    k_lF=2.0e-5,                                # lymphatic clearance of free ADC (/s)
    k_lP=5.0e-3, k_up=8.0e-3,                   # payload clearance & cellular uptake (/s)
    k_rep=2.0e-5,                               # sub-lethal repair (/s)
    DAR=8.0, f_leak=0.6,                        # payload loading / leak fraction
    L50q=1.0e4, h_kill=4.0, kmax_kill=1.5e-5,   # potency (molecules/cell, Hill)
    Ag0=1.0,                                    # ~2e6 HER2/cell, dense tumour (uM)
    C0=0.4,                                     # plasma Cmax, uM (~3 mg/kg, 150 kDa)
    t12_plasma=4.5 * 86400.0,                   # antibody plasma half-life (s)
    T_round=7.0 * 86400.0, T_gap=14.0 * 86400.0, n_rounds=4,
    Rh=0.62, s_vas=6.0, gam_pv=2.8, depot_scale=0.015, P_floor=0.02,
    kg=2.7e-7, k_n=2.0e-7,                      # regrowth / debris clearance (/s)
)

AFFINITIES = {
    'high': dict(koff=1.0e-6, label='10 pM ultra-high-affinity ADC', tag='10pM'),
    'med':  dict(koff=5.0e-4, label='5 nM balanced-affinity ADC',    tag='5nM'),
}

def plasma_conc(t, par):
    ke = np.log(2.0) / par['t12_plasma']
    return par['C0'] * np.exp(-ke * max(float(t), 0.0))

def build_mesh(par):
    a, L, N = par['a'], par['L'], par['N']
    dx = L / N
    r_l = a + np.arange(N) * dx
    r_r = a + np.arange(1, N + 1) * dx
    r_c = 0.5 * (r_l + r_r)
    return dict(dx=dx, r_c=r_c, r_l=r_l, r_r=r_r,
                coef_up=r_r / (r_c * dx * dx),
                coef_low=r_l / (r_c * dx * dx),
                wallgeo=a / (r_c[0] * dx))

# --------------------------------------------------------------------------
# implicit cylindrical diffusion
# --------------------------------------------------------------------------
def _tridiag(D, mesh):
    """sub/dia/sup of -div(D grad) on the cylindrical FV grid."""
    N = D.size
    sub = np.zeros(N); dia = np.zeros(N); sup = np.zeros(N)
    for i in range(1, N):
        val = mesh['coef_low'][i] * 0.5 * (D[i - 1] + D[i])
        sub[i] = val; dia[i] -= val
    for i in range(N - 1):
        val = mesh['coef_up'][i] * 0.5 * (D[i] + D[i + 1])
        sup[i] = val; dia[i] -= val
    return sub, dia, sup

def _thomas(sub, dia, sup, rhs):
    n = rhs.size
    b = np.empty(n); d = np.empty(n)
    b[0] = dia[0]; d[0] = rhs[0]
    for i in range(1, n):
        m = sub[i] / b[i - 1]
        b[i] = dia[i] - m * sup[i - 1]
        d[i] = rhs[i] - m * d[i - 1]
    x = np.empty(n)
    x[n - 1] = d[n - 1] / b[n - 1]
    for i in range(n - 2, -1, -1):
        x[i] = (d[i] - sup[i] * x[i + 1]) / b[i]
    return x

def diffuse_implicit(c, D, dt, mesh):
    """Backward-Euler: (I - dt T) c_new = c_old."""
    sub, dia, sup = _tridiag(D, mesh)
    return _thomas(-dt * sub, 1.0 - dt * dia, -dt * sup, c.copy())

# --------------------------------------------------------------------------
# reaction step
# --------------------------------------------------------------------------
def react_update(u, mesh, par, cp_now, dt):
    F, Ag, Ab, Abi, Pay, q, v, n = (u['F'], u['Ag'], u['Ab'], u['Abi'],
                                    u['Pay'], u['q'], u['v'], u['n'])
    kon = par['kon'] * 1e-6               # /uM/s
    koff = par['koff']; kint = par['k_int']; kend = par['k_end']
    krel = par['k_rel']; klF = par['k_lF']; klP = par['k_lP']
    kup = par['k_up']; krep = par['k_rep']
    DAR = par['DAR']; fleak = par['f_leak']
    L50q = par['L50q']; h = par['h_kill']; kmax = par['kmax_kill']
    Ag0 = par['Ag0']; g = par['w0'] * u['P_intra'] * par['a']
    rc, dx = mesh['r_c'], mesh['dx']

    bind = np.minimum(kon * F * Ag, np.minimum(F / (dt + 1e-30),
                                               Ag / (dt + 1e-30)))
    unbind = koff * Ab
    internal = kint * Ab
    rel = krel * Abi * DAR                  # uM payload processed / s

    dF = (-bind + unbind - klF * F)
    dAg = (-bind + unbind - internal + kend * (np.maximum(Ag0 * v, 0.0) - Ag))
    dAb = (bind - unbind - internal)
    dAbi = (internal - krel * Abi)
    dPay = (rel * fleak - (klP + kup * v) * Pay)

    # advection (outward Starling drift), area-velocity product g = const
    if g > 0:
        for name in ('F', 'Pay'):
            c = u[name]
            cprev = np.concatenate(([0.0], c[:-1]))
            adv = g * (cprev - c) / (rc * dx)
            if name == 'F':
                dF += adv
            else:
                dPay += adv

    # intracellular payload accumulation (per surviving cell)
    q_own = krel * Abi * (1.0 - fleak) * DAR * MOL_UMM
    up_rate = kup * v * Pay
    q_up = up_rate * MOL_UMM
    dq = (q_own + q_up) * np.minimum(v, 1.0) - krep * q

    # death
    S = q ** h / (q ** h + L50q ** h + 1e-300)
    dead = np.minimum(kmax * S * v * dt, v)

    # wall exchange on the first (wall-adjacent) cell
    wg = mesh['wallgeo']
    dF[0] += u['P_intra'] * par['P_vas'] * (cp_now - F[0]) * wg
    dPay[0] -= u['P_intra'] * par['P_pay_wall'] * Pay[0] * wg

    u['F'] = np.maximum(F + dF * dt, 0.0)
    u['Ag'] = np.maximum(Ag + dAg * dt, 0.0)
    u['Ab'] = np.maximum(Ab + dAb * dt, 0.0)
    u['Abi'] = np.maximum(Abi + dAbi * dt, 0.0)
    u['Pay'] = np.maximum(Pay + dPay * dt, 0.0)
    u['q'] = np.maximum(q + dq * dt, 0.0)
    vnew = np.maximum(v - dead, 0.0)
    u['n'] = np.minimum(n + (v - vnew), 1.0)
    u['v'] = vnew

def react_integrate(u, mesh, par, cp_now, dt_total):
    rmax = (par['kon'] * 1e-6 * (u['F'].max() + u['Ag'].max() + par['Ag0'])
            + par['k_int'] + par['k_end'] + par['k_lP']
            + par['k_up'] * u['v'].max() + par['kmax_kill']
            + (par['P_vas'] + par['P_pay_wall']) * mesh['wallgeo'])
    dr = min(dt_total, 0.35 / max(rmax, 1e-4))
    nsub = max(1, int(np.ceil(dt_total / dr)))
    dr = dt_total / nsub
    for _ in range(nsub):
        react_update(u, mesh, par, cp_now, dr)

# --------------------------------------------------------------------------
# vessel patency / ring necrosis
# --------------------------------------------------------------------------
def ring_mask(mesh, par, width=20.0):
    return (mesh['r_c'] - par['a']) <= width

def ring_necro(u, mask):
    return float(np.mean(u['n'][mask])) if mask.any() else 0.0

def set_patency(u, mask, par, Pbase, ring0):
    """Acute microvessel closure driven by *fresh* perivascular necrosis
    (new cell lysis in the 0..20 um ring during this round), scaled by the
    chronic baseline patency Pbase of the cycle."""
    Rnc_fresh = max(ring_necro(u, mask) - ring0, 0.0)
    P = Pbase / (1.0 + (Rnc_fresh / par['Rh']) ** par['s_vas'])
    u['P_intra'] = P
    return P, Rnc_fresh

def init_state(par, mesh):
    N = par['N']
    u = dict(v=np.full(N, 0.95), n=np.full(N, 0.05))
    u['Ag'] = par['Ag0'] * u['v'].copy()
    u['F'] = np.zeros(N); u['Ab'] = np.zeros(N); u['Abi'] = np.zeros(N)
    u['Pay'] = np.zeros(N); u['q'] = np.zeros(N); u['P_intra'] = 1.0
    return u

# --------------------------------------------------------------------------
# one on-treatment round (transport) + regrowth gap
# --------------------------------------------------------------------------
def _blocks(T, smoke):
    if smoke:
        return [(0.0, 1800.0, 2.0), (1800.0, T, 10.0)]
    return [(0.0, 600.0, 2.0), (600.0, 7200.0, 5.0),
            (7200.0, 172800.0, 10.0), (172800.0, T, 20.0)]

def run_round(u, mesh, mask_ring, par, Pbase, rec_dt, smoke):
    T = par['T_round']
    n_steps = int(np.ceil(T / rec_dt))
    rec = dict(t=np.empty(n_steps + 1))
    for k in ('F', 'Ab', 'Abi', 'totalAb', 'v', 'n', 'Pay', 'q'):
        rec[k] = np.empty((n_steps + 1, par['N']))
    rec['P_intra'] = np.empty(n_steps + 1)
    rec['P_intra'][0] = Pbase

    t = 0.0; idx = 1
    t_close = None
    ring0 = ring_necro(u, mask_ring)   # baseline ring necrosis at cycle start

    def snap(i):
        rec['t'][i] = t
        rec['totalAb'][i] = u['F'] + u['Ab'] + u['Abi']
        for k in ('F', 'Ab', 'Abi', 'v', 'n', 'Pay', 'q'):
            rec[k][i] = u[k]
        rec['P_intra'][i] = u['P_intra']

    snap(0)
    next_rec = rec_dt
    for (t0, t1, dt) in _blocks(T, smoke):
        while t < t1 - 1e-9:
            dt_eff = min(dt, t1 - t)
            cp = plasma_conc(t, par)
            set_patency(u, mask_ring, par, Pbase, ring0)
            react_integrate(u, mesh, par, cp, dt_eff)
            # implicit diffusion (D reduced across necrotic / compacted debris)
            neff = np.clip(u['n'], 0.0, 1.0)
            Df = par['D_ADC'] * np.exp(-par['D_nec'] * neff)
            u['F'] = diffuse_implicit(u['F'], np.maximum(Df, 1e-3), dt_eff, mesh)
            Dp = par['D_PAY'] * np.exp(-0.6 * neff)
            u['Pay'] = diffuse_implicit(u['Pay'], np.maximum(Dp, 1e-3), dt_eff, mesh)
            t += dt_eff
            if u['P_intra'] < 0.5 and t_close is None:
                t_close = t
            if t >= next_rec - 1e-9:
                snap(idx); idx += 1
                next_rec += rec_dt
    if rec['t'][idx - 1] < T - 1e-6 and idx < n_steps + 1:
        t = T; snap(idx); idx += 1

    # truncate unused rows
    rec = {k: (v[:idx] if v.ndim == 1 else v[:idx]) for k, v in rec.items()}

    # round-end metrics
    vol = mesh['r_c'] * mesh['dx']
    v_ring_end = float(np.mean(u['v'][mask_ring]))
    v_total_end = float(np.sum(u['v'] * vol) / np.sum(vol))
    ring_kill = 1.0 - v_ring_end
    stats = dict(patency_min=float(rec['P_intra'].min()), v_ring_end=v_ring_end,
                 v_total_end=v_total_end, ring_kill=ring_kill,
                 t_close=(t_close if t_close is not None else float('nan')))
    return rec, stats

def regrow_gap(u, mesh, par, T_gap):
    """Off-treatment window: regrowth + repair AND drug-species wash-out.

    No new dose.  Species evolve in closed form per node (vectorized):
      F   -> 0 (cleared from the gap start; no influx)
      Ab  decays by dissociation/internalization: rate (k_off + k_int*v)
      Abi -> processed to payload (k_rel) then cleared
      Pay cleared at (k_lP + k_up*v); sub-lethal q repaired at k_rep
      v regrows into freed space; necrotic debris is slowly resorbed (k_n)

    Consequence for affinity: a 10 pM binding (k_off ~1e-6/s, t1/2 ~8 d)
    persists on necrotic perivascular debris through the 14 d gap -> chronic
    thrombus / "pM-coated plug" -> vessel does NOT recanalise.  A 5 nM
    binding (k_off = 5e-4/s) dissociates in minutes and the free ADC clears
    -> perivascular debris is resorbed and the microvessel recovers.
    """
    dt = 1800.0; t = 0.0
    kg, kn, krep = par['kg'], par['k_n'], par['k_rep']
    koff = par['koff']; kint = par['k_int']; krel = par['k_rel']
    klP = par['k_lP']; kup = par['k_up']
    u['F'][:] = 0.0
    while t < T_gap:
        v = u['v']
        u['Ab'] *= np.exp(-(koff + kint * v) * dt)
        u['Abi'] *= np.exp(-krel * dt)
        u['Pay'] *= np.exp(-(klP + kup * v) * dt)
        u['q'] *= np.exp(-krep * dt)
        space = np.maximum(1.0 - u['n'], 0.05)
        u['v'] = np.minimum(np.maximum(v + kg * v * (1.0 - v / space) * dt, 0.0), space)
        u['n'] = np.maximum(u['n'] - kn * u['n'] * dt, 0.0)
        u['Ag'] = par['Ag0'] * u['v']
        t += dt

# --------------------------------------------------------------------------
# multi-round driver
# --------------------------------------------------------------------------
def wall_depot(u, mesh, par, width=30.0):
    """Persistent perivascular ADC depot (Ab + internalized) in the 0..30 um ring."""
    w = (mesh['r_c'] - par['a']) <= width
    vol = mesh['r_c'] * mesh['dx']
    return float(np.sum((u['Ab'] + u['Abi'])[w] * vol[w]))

def run_case(case, outdir=None, smoke=False):
    par = dict(DEFAULTS); par.update(AFFINITIES[case])
    if smoke:
        par['T_round'] = 12.0 * 3600.0
        par['n_rounds'] = 1
    mesh = build_mesh(par)
    u = init_state(par, mesh)
    mask_ring = ring_mask(mesh, par)
    Pbase = 1.0
    rec_dt = 1800.0

    rounds, stats_all, P_hist, depot_hist = [], [], [], []
    for r in range(par['n_rounds']):
        P_hist.append(Pbase)
        # fresh dose; tissue drug from the previous round was cleared in the gap
        u['F'][:] = 0.; u['Ab'][:] = 0.; u['Abi'][:] = 0.; u['Pay'][:] = 0.
        rec, st = run_round(u, mesh, mask_ring, par, Pbase, rec_dt, smoke)
        st['patency_start'] = Pbase
        st['v_total_after_gap'] = None
        rounds.append(rec); stats_all.append(st)
        if r < par['n_rounds'] - 1:
            regrow_gap(u, mesh, par, par['T_gap'])
            st['v_total_after_gap'] = float(np.sum(u['v'] * mesh['r_c'] * mesh['dx']) /
                                            np.sum(mesh['r_c'] * mesh['dx']))
            # persistent perivascular ADC depot after the gap drives chronic
            # micro-vascular occlusion (pM coating cannot be cleared -> no
            # recanalization; nM dissociates -> vessel recovers).
            depot = wall_depot(u, mesh, par)
            depot_hist.append(depot)
            st['depot_after_gap'] = depot
            Pbase = max(par['P_floor'],
                        Pbase * np.exp(-par['gam_pv'] * depot / max(par['depot_scale'], 1e-12)))
        else:
            st['depot_after_gap'] = 0.0

    # penetration metrics from the round-1 profile nearest 72 h
    rec0 = rounds[0]
    t72 = 3.0 * 86400.0
    i72 = int(np.argmin(np.abs(rec0['t'] - t72)))
    prof = rec0['totalAb'][i72]
    x = mesh['r_c'] - par['a']
    m = prof.max()
    pen = dict(p90=np.nan, p50=np.nan, p10=np.nan, xpeak=float(x[np.argmax(prof)]))
    if m > 0:
        for key, fr in (('p90', 0.9), ('p50', 0.5), ('p10', 0.1)):
            idx = np.where(prof >= m * fr)[0]
            pen[key] = float(x[idx.max()]) if idx.size else 0.0

    res = dict(case=case, par=par, meshx=x, mesh=mesh,
               rounds=rounds, stats=stats_all, patency_start=P_hist, pen=pen)
    if outdir:
        os.makedirs(outdir, exist_ok=True)
        save_results(res, outdir)
    return res

def save_results(res, outdir):
    fname = os.path.join(outdir, f"results_{res['case']}.npz")
    r0 = res['rounds'][0]
    np.savez_compressed(
        fname,
        case=res['case'],
        pen_p90=res['pen']['p90'], pen_p50=res['pen']['p50'], pen_p10=res['pen']['p10'],
        pen_xpeak=res['pen']['xpeak'],
        patency_start=np.array(res['patency_start']),
        viable_round=np.array([s['v_total_end'] for s in res['stats']]),
        viable_gap=np.array([s['v_total_after_gap'] if s['v_total_after_gap'] is not None
                             else s['v_total_end'] for s in res['stats']]),
        ring_kill=np.array([s['ring_kill'] for s in res['stats']]),
        patency_min=np.array([s['patency_min'] for s in res['stats']]),
        t_close=np.array([s['t_close'] for s in res['stats']]),
        depot=np.array([s['depot_after_gap'] for s in res['stats']]),
        meshx=res['meshx'],
        t=r0['t'], totalAb=r0['totalAb'], v=r0['v'], n=r0['n'],
        Ab=r0['Ab'], Abi=r0['Abi'], F=r0['F'], q=r0['q'],
        Pay=r0['Pay'], P_intra=r0['P_intra'],
    )
    print(f"[save] {fname}")

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--case', choices=['high', 'med'], required=True)
    ap.add_argument('--outdir', default='.')
    ap.add_argument('--smoke', action='store_true')
    args = ap.parse_args()
    run_case(args.case, outdir=args.outdir, smoke=args.smoke)
    print('done')
