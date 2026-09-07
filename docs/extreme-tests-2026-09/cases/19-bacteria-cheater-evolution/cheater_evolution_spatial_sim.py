"""
cheater_evolution_spatial_sim.py
================================
Evolutionary / ecological simulation of a Synthetic Lysis Circuit (SLC)
engineered-bacteria cancer therapy invaded by "cheater" mutants (QS-blind /
payload-null / non-lysing escape mutants).

Two complementary idealisations are provided and compared:

  (1) WELL-MIXED mean-field model (event-driven ODE, single stirred patch).
      Logistic space cap, deterministic mutation at division, and lysis as a
      *threshold event*: when the shared AHL pool reaches Ath, a fraction
      (1 - s) of the COOPERATOR population lyses synchronously (s = engineered
      survivor fraction).  This idealisation captures the analytic per-pulse
      cheater enrichment factor 1/s and the sharp collapse boundary.

  (2) SPATIAL lattice Monte Carlo (2-D). A solid-tumour interstitial grid:
      * nutrient diffusion + vascular resupply + uptake (Monod),
      * contact-inhibited (empty-neighbour) cell division -> colony fronts,
      * shared AHL pool (fast-mixing 3OC6-HSL) with the *same* event-driven
        threshold lysis and survivor fraction s,
      * loss-of-function mutation (cooperator -> cheater) at division at rate
        mu, with the newborn placed in the mother's immediate neighbourhood,
        so cheaters grow as spatially coherent clones/sectors and spread by
        physical exclusion - the key difference from the well-mixed case.

Units: time is in units of the unburdened bacterial doubling time (~tau=1);
length is in cell diameters (lattice sites).

Figures/pulse-series are returned as dicts; plotting is left to the caller
(this module ships simulators + a small CLI that writes data tables).

Example CLI:

    python cheater_evolution_spatial_sim.py --engine wellmixed --mu 1e-5
    python cheater_evolution_spatial_sim.py --engine spatial --mu 1e-5 --L 150
"""

import argparse
import os
import time as _time

import numpy as np

# ----------------------------------------------------------------------------
# 1.  WELL-MIXED MEAN-FIELD MODEL (event-driven threshold lysis)
# ----------------------------------------------------------------------------

WELLMIXED_DEFAULTS = dict(
    K=1.0e9,          # logistic carrying capacity of the stirred patch (cells)
                      # clinical-scale: mutation supply at mu ~ 1e-6 is still
                      # deterministic (no sub-cellular artefacts)
    g0=0.693,         # max specific division rate = ln2 (1 / doubling time)
    burden=0.25,      # synthetic burden paid by cooperators
    s=0.02,           # engineered survivor fraction of a lysis event
    alpha=1.0,        # AHL secretion per cooperator per unit time
    gammaA=1.0,       # AHL decay rate
    Ath=2.5e8,        # activation threshold -> C* = Ath*gammaA/alpha = K/4
    dt=0.01,
    C0=2.5e7, D0=0.0,  # C0 = C*/10
    A0=0.0,
)


def run_wellmixed(mu=0.0, t_max=400.0, p=None, record=True,
                  pulse_stop_frac=1e-4):
    """Integrate the event-driven ODE model (single well-stirred patch).

    Returns dict: t,C,D,A,pulse_dose,pulse_time.
    Integration stops on functional extinction (a pulse < pulse_stop_frac of
    the first) or when no pulse fires for 8 nominal periods.
    """
    par = dict(WELLMIXED_DEFAULTS)
    if p:
        par.update(p)
    K, g0 = par["K"], par["g0"]
    burden, s = par["burden"], par["s"]
    alpha, gammaA, Ath = par["alpha"], par["gammaA"], par["Ath"]
    dt = par["dt"]

    C, D = par["C0"], par["D0"]
    A = par["A0"]

    t = 0.0
    ts, Cs, Ds, As = [0.0], [C], [D], [A]
    pulse_dose, pulse_time = [], []
    fired = False
    first_amp = None
    t_last = -1e9
    period_est = None

    def _fire(tnow):
        nonlocal C, A
        lysed = (1.0 - s) * C
        C = s * C
        A = min(alpha * C / gammaA, Ath * 0.9)   # relax to survivors' level
        pulse_dose.append(lysed)
        pulse_time.append(tnow)

    while t < t_max:
        X = C + D
        lim = max(1.0 - X / K, 0.0)
        gC = g0 * (1.0 - burden) * lim * C
        gD = g0 * lim * D
        mut = mu * max(gC, 0.0)                  # cheaters from C divisions
        C += dt * (gC - mut)
        D += dt * (gD + mut)
        A += dt * (alpha * C - gammaA * A)
        t += dt

        if A >= Ath and not fired:
            fired = True
            _fire(t)
            if first_amp is None:
                first_amp = pulse_dose[0]
            if pulse_dose[-1] < pulse_stop_frac * first_amp:
                break
            if period_est is None and len(pulse_time) >= 2:
                period_est = pulse_time[-1] - pulse_time[-2]
            t_last = t
        elif A < Ath * 0.9:
            fired = False
        if period_est and t - t_last > 8.0 * period_est:
            break
        if record:
            ts.append(t); Cs.append(C); Ds.append(D); As.append(A)

    return dict(t=np.array(ts), C=np.array(Cs), D=np.array(Ds), A=np.array(As),
                pulse_dose=np.array(pulse_dose), pulse_time=np.array(pulse_time))


# ----------------------------------------------------------------------------
# 2.  SPATIAL LATTICE MONTE CARLO  (solid-tumour interstitial grid)
# ----------------------------------------------------------------------------

SPATIAL_DEFAULTS = dict(
    L=150,                # lattice side length (sites)
    dt=0.01,              # integration step (units of doubling time)
    # growth / metabolism
    g0=0.693,             # max specific division rate (1 / doubling time)
    burden=0.22,          # fractional growth penalty paid by cooperators
    Kn=0.08,              # Monod half-saturation for nutrient
    N0=1.6,               # nutrient set-point of the local vascular supply
    k_sup=0.20,           # distributed nutrient resupply rate (perfusion)
    uptake=0.08,          # nutrient units consumed per biomass unit grown
    recycle=0.25,         # fraction of lysed biomass recycled as nutrient
    D_nut=1.5,            # nutrient diffusion coefficient (site^2 / time)
    # shared QS pool + event-driven lysis
    #   dA/dt = alpha*C_active - gammaA*A ;  lysis when A >= Ath
    alpha=1.25e-4,        # AHL secretion per active cooperator per unit time
    gammaA=0.5,           # AHL decay rate
    Ath=0.5,              # activation threshold -> C* ~ 2000 active coops
    s=0.05,               # engineered survivor fraction per lysis pulse
    # evolution
    mu=1e-5,              # loss-of-function mutation rate per division
    cheat0=0.0,           # pre-existing cheater fraction in the inoculum
    # inoculum & colonisable niche
    tumor_r=None,         # radius of the colonisable tumour disk (None: L*0.37)
    inoc_r=9,             # inoculum radius (sites)
    inoc_frac=0.55,       # occupancy fraction inside the inoculum disk
    seed=1,
)


class SpatialLattice:
    """2-D solid-tumour lattice with event-driven SLC lysis.

    cell : int array (0 empty, 1 cooperator, 2 cheater)
    nut  : nutrient concentration field
    A    : shared extracellular AHL pool (scalar)
    """

    def __init__(self, L=None, p=None, seed=1):
        par = dict(SPATIAL_DEFAULTS)
        if p:
            par.update(p)
        if L is not None:
            par["L"] = L
        self.p = par
        self.L = int(par["L"])
        self.dt = par["dt"]
        self.rng = np.random.default_rng(seed)
        self._reset()

    # -- grid bookkeeping ----------------------------------------------------
    def _diffuse(self, field, D):
        """Explicit reflecting-boundary diffusion (4-neighbour)."""
        v = np.pad(field, 1, mode="edge")
        lap = (v[:-2, 1:-1] + v[2:, 1:-1] + v[1:-1, :-2]
               + v[1:-1, 2:] - 4.0 * field)
        return field + self.dt * D * lap

    def _reset(self):
        p, L = self.p, self.L
        self.cell = np.zeros((L, L), dtype=np.int8)
        self.nut = np.full((L, L), p["N0"], dtype=np.float64)
        self.A = 0.0
        yy, xx = np.mgrid[0:L, 0:L]
        r2 = (xx - (L - 1) / 2.0) ** 2 + (yy - (L - 1) / 2.0) ** 2
        # colonisable tumour niche (finite disk; outside is impassable ECM)
        Rt = p["tumor_r"] if p["tumor_r"] else 0.37 * L
        self.tumor = r2 <= Rt ** 2
        # dense inoculum disk in the centre
        disk = r2 <= p["inoc_r"] ** 2
        cand = np.argwhere(disk)
        n_occ = int(round(p["inoc_frac"] * cand.shape[0]))
        sel = cand[self.rng.choice(cand.shape[0], n_occ, replace=False)]
        self.cell[sel[:, 0], sel[:, 1]] = 1
        # pre-existing cheater reservoir (loss-of-function mutants in the lot)
        if p["cheat0"] > 0:
            n_cheat = self.rng.binomial(n_occ, min(p["cheat0"], 1.0))
            if n_cheat:
                k = self.rng.choice(n_occ, n_cheat, replace=False)
                self.cell[sel[k, 0], sel[k, 1]] = 2
        self.nsteps = 0
        self.dose_cum = 0.0
        self._fired = False
        # pulse record: (time, total_cooperators_lysed) + pre-pulse counts
        self.pulse_time, self.pulse_amp = [], []
        self.pulse_C, self.pulse_D = [], []
        self.last_pulse_t = None

    # -- accessors -----------------------------------------------------------
    @property
    def nC(self):
        return int((self.cell == 1).sum())

    @property
    def nD(self):
        return int((self.cell == 2).sum())

    @property
    def n_cells(self):
        return int((self.cell > 0).sum())

    # -- one update ----------------------------------------------------------
    def step(self):
        p, dt = self.p, self.dt
        cell = self.cell

        # 1. nutrient: mild diffusion + perfusion + uptake (Monod)
        nut = self._diffuse(self.nut, p["D_nut"])
        nut += dt * p["k_sup"] * (p["N0"] - nut)
        mon = nut / (nut + p["Kn"])
        nut = np.maximum(nut - dt * p["uptake"] * p["g0"] * mon * (cell > 0), 0.0)
        self.nut = nut

        # 2. shared QS pool: dA/dt = alpha*C_active - gammaA*A
        active = (cell == 1) & (mon > 0.05)
        self.A += dt * (p["alpha"] * int(active.sum()) - p["gammaA"] * self.A)
        if self.A < 0.0:
            self.A = 0.0

        # 3. threshold lysis event (SLC): all cooperators lyse except the
        #    engineered survivor fraction s; cheaters never lyse.
        if self.A >= p["Ath"] and not self._fired:
            self._fired = True
            Cmask = cell == 1
            C_before = int(Cmask.sum())
            D_before = int((cell == 2).sum())
            surv = self.rng.random(cell.shape) < p["s"]
            lysed = Cmask & ~surv
            n_lyse = int(lysed.sum())
            if n_lyse:
                cell[lysed] = 0
                nut = np.where(lysed, np.minimum(nut + p["recycle"], p["N0"] * 1.5),
                               nut)
                self.nut = nut
                self.dose_cum += n_lyse
                self.pulse_time.append(self.nsteps * dt)
                self.pulse_amp.append(n_lyse)
                self.pulse_C.append(C_before)
                self.pulse_D.append(D_before)
                self.last_pulse_t = self.nsteps * dt
            # survivors' quasi-steady AHL (well below threshold)
            C_surv = int((cell == 1).sum())
            self.A = min(p["alpha"] * C_surv / p["gammaA"], p["Ath"] * 0.9)
        elif self.A < p["Ath"] * 0.9:
            self._fired = False

        # 4. division into an empty neighbour (contact-inhibited growth)
        empty = cell == 0
        has_space = np.zeros((self.L, self.L), dtype=bool)
        has_space[1:, :] |= empty[:-1, :]
        has_space[:-1, :] |= empty[1:, :]
        has_space[:, 1:] |= empty[:, :-1]
        has_space[:, :-1] |= empty[:, 1:]

        mothers = (cell > 0) & has_space
        prob = np.where(cell == 2,
                        dt * p["g0"] * mon,
                        dt * p["g0"] * (1.0 - p["burden"]) * mon)
        born = mothers & (self.rng.random(cell.shape) < prob)
        mi, mj = np.nonzero(born)
        claimed = np.zeros((self.L, self.L), dtype=bool)
        T = self.tumor
        for a, b in zip(mi, mj):
            neigh = []
            if a > 0 and cell[a - 1, b] == 0 and not claimed[a - 1, b] and T[a - 1, b]:
                neigh.append((a - 1, b))
            if a < self.L - 1 and cell[a + 1, b] == 0 and not claimed[a + 1, b] and T[a + 1, b]:
                neigh.append((a + 1, b))
            if b > 0 and cell[a, b - 1] == 0 and not claimed[a, b - 1] and T[a, b - 1]:
                neigh.append((a, b - 1))
            if b < self.L - 1 and cell[a, b + 1] == 0 and not claimed[a, b + 1] and T[a, b + 1]:
                neigh.append((a, b + 1))
            if not neigh:
                continue
            ci, cj = neigh[self.rng.integers(0, len(neigh))]
            typ = cell[a, b]
            if typ == 1 and self.rng.random() < p["mu"]:
                typ = 2                     # loss-of-function mutation
            cell[ci, cj] = typ
            claimed[ci, cj] = True

        self.nsteps += 1
        return

    # -- run -----------------------------------------------------------------
    def run(self, t_max, record_every=0.5, snapshot_times=()):
        """Run for t_max (time units). Returns a result dict."""
        dt = self.dt
        rec_step = max(1, int(round(record_every / dt)))
        snap = sorted(snapshot_times)
        snap_i = [int(round(s / dt)) for s in snap]

        ts, Cs, Ds, As = [], [], [], []
        shots = {}
        n_steps = int(round(t_max / dt))
        for k in range(n_steps + 1):
            if k % rec_step == 0:
                ts.append(k * dt)
                Cs.append(self.nC)
                Ds.append(self.nD)
                As.append(self.A)
            if snap_i and k == snap_i[0]:
                shots[k * dt] = (self.cell.copy(), self.nut.copy(), self.A)
                snap_i.pop(0)
            self.step()
            # early stop once the oscillator has stalled (dosing extinct)
            if (len(self.pulse_time) >= 3 and self.last_pulse_t is not None
                    and (k * dt - self.last_pulse_t) > 12.0):
                break
        return dict(t=np.array(ts), C=np.array(Cs), D=np.array(Ds), A=np.array(As),
                    pulse_time=np.array(self.pulse_time),
                    pulse_amp=np.array(self.pulse_amp, dtype=float),
                    pulse_C=np.array(self.pulse_C, dtype=float),
                    pulse_D=np.array(self.pulse_D, dtype=float),
                    dose_cum=self.dose_cum, shots=shots)


# ----------------------------------------------------------------------------
# 2b. WELL-MIXED STOCHASTIC (0-D) model
# ----------------------------------------------------------------------------
# Same per-cell rules and the same carrying capacity as the spatial lattice
# (so the two can be compared on equal footing), but with NO spatial
# structure: contact-limitation is replaced by a global logistic cap K and the
# shared AHL pool drives a synchronous lysis event.  Difference from the
# deterministic ODE: populations are integer, mutation and survival are
# stochastic -> Luria-Delbruck waiting times appear at low mu.

WELLMIXED_STOCH_DEFAULTS = dict(
    K=3200,               # logistic carrying capacity (matches lattice colony)
    g0=0.693,
    burden=0.22,
    s=0.05,               # survivor fraction per pulse (same as lattice)
    alpha=1.25e-4,        # -> C* = Ath*gammaA/alpha ~ 2000 (same as lattice)
    gammaA=0.5,
    Ath=0.5,
    C0=400, D0=0,
    dt=0.01,
)


class WellMixedStochastic:
    """0-D stochastic (birth-death + lysis events) well-mixed model."""

    def __init__(self, p=None, seed=1):
        par = dict(WELLMIXED_STOCH_DEFAULTS)
        if p:
            par.update(p)
        self.p = par
        self.dt = par["dt"]
        self.rng = np.random.default_rng(seed)
        self.reset()

    def reset(self, mu=0.0):
        p = self.p
        self.mu = mu
        self.C = int(p["C0"])
        self.D = int(p["D0"])
        self.A = 0.0
        self._fired = False
        self.nsteps = 0
        self.pulse_time, self.pulse_amp = [], []
        self.pulse_C, self.pulse_D = [], []
        self.dose_cum = 0.0

    def step(self):
        p, dt = self.p, self.dt
        X = self.C + self.D
        lim = max(1.0 - X / p["K"], 0.0)
        lamC = self.C * p["g0"] * (1.0 - p["burden"]) * lim
        lamD = self.D * p["g0"] * lim
        nbC = self.rng.poisson(lamC * dt)
        nbD = self.rng.poisson(lamD * dt)
        n_mut = self.rng.binomial(nbC, self.mu) if nbC else 0
        self.C += nbC - n_mut
        self.D += nbD + n_mut
        self.A += dt * (p["alpha"] * self.C - p["gammaA"] * self.A)
        if self.A < 0:
            self.A = 0.0
        if self.A >= p["Ath"] and not self._fired:
            self._fired = True
            if self.C > 0:
                C_before, D_before = self.C, self.D
                n_surv = self.rng.binomial(self.C, p["s"])
                n_lysed = self.C - n_surv
                self.dose_cum += n_lysed
                self.pulse_amp.append(n_lysed)
                self.pulse_time.append(self.nsteps * dt)
                self.pulse_C.append(C_before)
                self.pulse_D.append(D_before)
                self.C = n_surv
            self.A = min(p["alpha"] * self.C / p["gammaA"], p["Ath"] * 0.9)
        elif self.A < p["Ath"] * 0.9:
            self._fired = False
        self.nsteps += 1

    def run(self, t_max, mu=0.0, record_every=0.5):
        self.reset(mu=mu)
        dt = self.dt
        rec = max(1, int(round(record_every / dt)))
        ts, Cs, Ds, As = [], [], [], []
        for k in range(int(round(t_max / dt)) + 1):
            if k % rec == 0:
                ts.append(k * dt); Cs.append(self.C)
                Ds.append(self.D); As.append(self.A)
            self.step()
        return dict(t=np.array(ts), C=np.array(Cs), D=np.array(Ds),
                    A=np.array(As), pulse_time=np.array(self.pulse_time),
                    pulse_amp=np.array(self.pulse_amp, dtype=float),
                    pulse_C=np.array(self.pulse_C, dtype=float),
                    pulse_D=np.array(self.pulse_D, dtype=float),
                    dose_cum=self.dose_cum)


# ----------------------------------------------------------------------------
# 3.  helpers
# ----------------------------------------------------------------------------

def analyse_pulses(pulse_amp, pulse_time, floor=0.10, stall_factor=4.0):
    """Robust summary of a pulse series.

    The 'functional extinction' of dosing is defined by the first pulse index
    where either (i) the pulse amplitude has fallen below `floor` times the
    plateau amplitude (median of the first few pulses), or (ii) the oscillator
    has stalled - the gap to the next pulse exceeds `stall_factor` times the
    median inter-pulse gap (dosing has died but the last amplitude was still
    large, the classic 'oscillator death').

    Returns (n_effective_pulses, extinction_time, last_pulse_time).
    """
    amp = np.asarray(pulse_amp, float)
    tt = np.asarray(pulse_time, float)
    n = amp.size
    if n == 0:
        return 0, np.nan, np.nan
    plateau = np.median(amp[: min(6, n)])
    if plateau <= 0:
        plateau = amp[0]
    gaps = np.diff(tt)
    med_gap = np.median(gaps) if gaps.size else np.inf
    fail = n
    for i in range(n):
        if amp[i] < floor * plateau:
            fail = i
            break
        if i < n - 1 and med_gap < np.inf and gaps[i] > stall_factor * med_gap:
            fail = i + 1        # stalled after pulse i
            break
    n_eff = int(fail)
    if n_eff >= n:
        return n, tt[-1], tt[-1]        # never collapsed within the horizon
    t_ext = tt[min(fail, n - 1)]
    return n_eff, t_ext, tt[-1]


# ----------------------------------------------------------------------------
# 4.  CLI
# ----------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--engine", choices=["wellmixed", "spatial", "both"],
                    default="spatial")
    ap.add_argument("--mu", type=float, default=None)
    ap.add_argument("--L", type=int, default=150)
    ap.add_argument("--t-end", type=float, default=250.0)
    ap.add_argument("--cheat0", type=float, default=None)
    ap.add_argument("--outdir", default=".")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    t0 = _time.time()
    if args.engine in ("spatial", "both"):
        p = dict(SPATIAL_DEFAULTS)
        if args.mu is not None:
            p["mu"] = args.mu
        if args.cheat0 is not None:
            p["cheat0"] = args.cheat0
        sim = SpatialLattice(L=args.L, p=p, seed=args.seed)
        res = sim.run(args.t_end)
        n_eff, ext_t, _ = analyse_pulses(res["pulse_amp"], res["pulse_time"])
        print(f"[spatial] mu={sim.p['mu']:.1e} cheat0={sim.p['cheat0']:.1e} "
              f"pulses={len(res['pulse_amp'])} effective={n_eff} "
              f"ext_t={ext_t:.1f}  nC={sim.nC} nD={sim.nD} "
              f"({_time.time() - t0:.1f}s)")
        np.savez(os.path.join(args.outdir, "spatial_result.npz"),
                 t=res["t"], C=res["C"], D=res["D"], A=res["A"],
                 pulse_time=res["pulse_time"], pulse_amp=res["pulse_amp"])
    if args.engine in ("wellmixed", "both"):
        mu = args.mu if args.mu is not None else 0.0
        res = run_wellmixed(mu=mu, t_max=args.t_end)
        n_eff, ext_t, _ = analyse_pulses(res["pulse_dose"], res["pulse_time"])
        print(f"[wellmixed] mu={mu:.1e} pulses={len(res['pulse_dose'])} "
              f"effective={n_eff} ext_t={ext_t:.1f} ({_time.time() - t0:.1f}s)")
        np.savez(os.path.join(args.outdir, "wellmixed_result.npz"),
                 t=res["t"], C=res["C"], D=res["D"], A=res["A"],
                 pulse_time=res["pulse_time"], pulse_amp=res["pulse_dose"])


if __name__ == "__main__":
    main()
