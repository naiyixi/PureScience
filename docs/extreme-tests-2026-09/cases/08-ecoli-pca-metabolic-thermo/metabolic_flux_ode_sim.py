#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
metabolic_flux_ode_sim.py
=========================
对抗性工程审查配套仿真:
过表达酪氨酸氨解酶(TAL)在 E. coli 中合成对羟基肉桂酸(p-coumaric acid)
—— 代谢通量 ODE 模型(10 状态),用于演示三种"致命工程缺陷"及工程化修正。

状态(单位):
  X  生物量                g DCW / L
  T  胞内 L-酪氨酸         mM (胞质体积)
  P  胞内 p-coumarate      mM (胞质体积)
  S  胞外 L-酪氨酸(补料储库) mM
  Pe 胞外 p-coumarate      mM (培养液)
  A  胞内总铵(NH3+NH4+)   mM
  m  PMF/膜健康           0..1  (1 = 完整)
  Q  AaeXAB/AaeAB 型外排泵量(可诱导)  mmol/gDCW/h 容量
  R  萃取相捕获的 pCA      mmol/L (仅当 ksink>0)

动力学要点
  * TAL: 单向率 ~ E*T/(Km+T), 含热力学可逆因子 psi=1-(P*NH3)/(T*Kc)(Kc≈3880 mM,
    现实胞内几乎恒 1,见报告热力学核查)与弱产物抑制.
  * Tyr 供给: 反馈抑制(ib) + TyrR 型阻遏(repT) + 外源摄取(H+-symport,需 PMF).
  * 外排泵 Q 由胞内 P 经 AaeR 型 sigmoid 诱导(转录滞后 tau_Q) — H+/底物反向转运.
  * 弱酸解偶联: 未解离 HA 穿膜渗漏 kL*(f_out*Pe - f_in*P); PMF 平衡受质子负荷与
    胞内/胞外 pCA 的膜损伤调制; m 低 -> 死亡项.
  * 补料: 脉冲注入胞外 Tyr(dose)每 feed_iv h.
  * 原位移除(ISPR/两相萃取): 一级去除率 ksink, 计入累积捕获 R.

运行:
  python metabolic_flux_ode_sim.py            # 复现全部情景 + 图 + CSV
  python metabolic_flux_ode_sim.py --scenario B_naive_fed --tf 20
依赖: numpy, scipy, matplotlib
"""
import argparse
import csv
import os

import numpy as np
from scipy.integrate import solve_ivp

# ---------------- 常数与物理 ----------------
KC_MM = 1000.0 * 3.88          # TAL 平衡 (P*NH3)/T ≈ 3880 mM (游离NH3, M级Keq×1000)

def frac_HA(pH, pKa=4.6):
    """弱酸未解离(中性、可穿膜)比例"""
    return 1.0 / (1.0 + 10.0 ** (pH - pKa))

def FNH3(pH):
    """游离 NH3 / 总氨 比例 (pKa NH4+=9.25)"""
    return 1.0 / (1.0 + 10.0 ** (9.25 - pH))

NAMES = ['X', 'T', 'P', 'S', 'Pe', 'A', 'm', 'Q', 'R']

# ---------------- 基础参数 ----------------
BASE = dict(
    theta_c=1.5e-3, Xmax=8.0,          # L胞质/gDCW; 培养容载 g/L
    mu_max=0.8, KTg=0.04, YTX=0.16,    # 最大比生长 /h; 生长Tyr需求; mmol Tyr/gDCW
    Vb=0.18, Kti=0.04, KrT=0.10,       # de novo Tyr 容量; 反馈与TyrR抑制(mM)
    Vup=0.30, Ku=0.008,                # 外源Tyr摄取 (mmol/g/h; Km mM)
    TALk=0.03, KmT=0.20, E=30.0, PInh=250.0,   # TAL (E=表达倍数; PInh=产物抑制mM)
    qbase=0.02, qmax=0.15, tau_Q=2.0, Qh=8.0, Qn=2.0,   # 外排泵诱导
    Kp=8.0, hc=1.0,                    # 外排 K_M(mM), 每分子外排质子代价
    kL=1.2, pHc=7.5, pHext=7.0,        # HA 渗漏系数; 胞质/培养液 pH
    JHmax=10.0, tau_m=0.10, P50=60.0, Pe50=22.0, n=2.0,  # PMF 平衡
    Vas=8.0, Ka=1.0,                   # 氨同化
    ksink=0.0, kd=0.25,                # 原位移除 /h; 死亡速率 /h
)

def make_ode(b):
    """返回 dY/dt。b: 参数字典。"""
    th = b['theta_c']; fin = frac_HA(b['pHc']); fout = frac_HA(b['pHext'])
    fn = FNH3(b['pHc'])
    def sigmoid_m(x, k=6.0, x0=0.3):
        return 1.0 / (1.0 + np.exp(-k * (x - x0)))
    def deriv(t, y):
        X, T, P, S, Pe, A, m, Q, R = y
        mu = b['mu_max'] * max(m, 0.0) * (T / (T + b['KTg'])) * (1.0 - X / b['Xmax'])
        death = b['kd'] * (1.0 - sigmoid_m(m))
        # ---- Tyr 供给 ----
        repT = 1.0 / (1.0 + (T / b['KrT']) ** 1.5)
        de = b['Vb'] / (1.0 + (T / b['Kti']) ** 2) * repT
        up = b['Vup'] * S / (b['Ku'] + S) * m
        rsup = de + up
        # ---- TAL ----
        rM = b['E'] * b['TALk'] * T / (T + b['KmT'])
        A_free = A * fn
        psi = max(0.0, 1.0 - (P * A_free) / (max(T, 1e-7) * KC_MM))
        rT = rM * psi * max(0.0, 1.0 - P / b['PInh'])
        rTr = rM * (1.0 - psi)                       # 反向氨化(极端情形)
        # ---- 主动外排 (Aae 型, H+-antiport) ----
        Vexp = Q
        rEx = Vexp * m * P / (b['Kp'] + P)
        # ---- 被动 HA 渗漏 ----
        rL = b['kL'] * (fout * Pe - fin * P)
        # ---- PMF / 膜健康 ----
        Ltot = max(rL, 0.0) + b['hc'] * rEx
        fmem = 1.0 / ((1.0 + (P / b['P50']) ** b['n']) *
                      (1.0 + (Pe / b['Pe50']) ** b['n']))
        meq = max(0.0, 1.0 - Ltot / b['JHmax']) * fmem
        rAs = b['Vas'] * A / (b['Ka'] + A)
        r_prot = mu * b['YTX']
        # ---- ODE ----
        dX = (mu - death) * X
        dT = (rsup - rT + rTr - r_prot) / th - mu * T
        dP = (rT - rTr - rEx + rL) / th - mu * P
        dS = -up * X
        dPe = (rEx - rL) * X - b['ksink'] * Pe
        dA = (rT - rTr - rAs) / th - mu * A
        dm = (meq - m) / b['tau_m']
        dQ = (b['qbase'] + (b['qmax'] - b['qbase']) * P ** b['Qn'] /
              (P ** b['Qn'] + b['Qh'] ** b['Qn']) - Q) / b['tau_Q']
        dR = b['ksink'] * Pe
        return [dX, dT, dP, dS, dPe, dA, dm, dQ, dR]
    return deriv

Y0 = [0.05, 0.10, 0.02, 0.0, 0.0, 20.0, 1.0, 0.02, 0.0]

def run_op(cfg, tf=40.0, feed_iv=None, feed_dose=0.0, y0=None):
    """分片(补料注入)+ LSODA 积分。返回 (t, Y[, state_cols=NAMES])。"""
    b = dict(BASE); b.update(cfg)
    ode = make_ode(b)
    y = np.array(Y0 if y0 is None else y0, float)
    t = 0.0; ts = [0.0]; Ys = [y.copy()]
    while t < tf - 1e-9:
        t1 = tf if feed_iv is None else min(t + feed_iv, tf)
        te = np.linspace(t, t1, int(round((t1 - t) / 0.005)) + 1)
        s = solve_ivp(ode, [t, t1], y, method='LSODA', rtol=1e-6, atol=1e-9, t_eval=te)
        y = s.y[:, -1]; ts.extend(te[1:]); Ys.extend(s.y[:, 1:].T); t = t1
        if feed_iv is not None and t < tf - 1e-9:
            y[3] += feed_dose                      # 胞外 Tyr 储库注入
    return np.array(ts), np.array(Ys)

def series(ts, Ys):
    return {k: v for k, v in zip(NAMES, Ys.T)}

# ---------------- 情景 ----------------
SCENARIOS = {
    'A_naive_batch': dict(cfg=dict(E=80.0, Vb=0.18, qmax=0.15, tau_Q=2.0), op=dict(tf=40)),
    'B_naive_fed':   dict(cfg=dict(E=80.0, Vb=0.18, qmax=0.15, tau_Q=2.0),
                          op=dict(tf=40, feed_iv=3.0, feed_dose=1.2)),
    'E_export_nosink': dict(cfg=dict(E=10.0, Vb=1.2, qmax=3.0, tau_Q=0.3, ksink=0.0),
                            op=dict(tf=40)),
    'C_eng_batch':   dict(cfg=dict(E=10.0, Vb=1.2, qmax=3.0, tau_Q=0.3, ksink=0.5),
                          op=dict(tf=40)),
}
MW_PCA = 164.16   # g/mol

def run_scenario(name, **op_over):
    sp = SCENARIOS[name]
    op = dict(sp['op']); op.update(op_over)
    return run_op(sp['cfg'], **op)

def summary_row(name, ts, Ys):
    d = series(ts, Ys)
    X, T, P, S, Pe, A, m, Q, R = [d[v] for v in NAMES]
    mu = np.diff(np.log(np.maximum(X, 1e-9))) / np.diff(ts)
    intra = P[-1] * 1.5e-3 * X[-1]
    ext = R[-1] + Pe[-1]
    return dict(scenario=name, t_end=float(ts[-1]), X_f=float(X[-1]),
                mu_avg=float(np.mean(mu)), T_end_uM=float(T[-1] * 1e3),
                P_int_max=float(P.max()), Pe_end=float(Pe[-1]),
                captured_R=float(R[-1]), m_min=float(m.min()),
                pCA_ext_gL=ext * MW_PCA / 1000.0, pCA_total_gL=(ext + intra) * MW_PCA / 1000.0)

# ---------------- 出图 ----------------
def plot_all(SOL, outfile='fig_ode_sim.png'):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.rcParams.update({'font.size': 9, 'axes.titlesize': 9.5, 'legend.fontsize': 7.5,
                         'lines.linewidth': 1.7, 'xtick.labelsize': 8, 'ytick.labelsize': 8,
                         'axes.spines.top': False})
    C = {'X': 'k', 'm': '0.45', 'T': '#1565c0', 'P': '#c62828', 'Pe': '#e65100', 'R': '#2e7d32'}
    LBL = {'X': 'X  (g DCW/L)', 'm': 'm  (PMF health)', 'T': 'Tyr$_{int}$ (µM)',
           'P': 'pCA$_{int}$ (µM)', 'Pe': 'pCA$_{broth}$ (µM)', 'R': 'captured pCA (µM)'}
    scen_title = {'A_naive_batch': 'A · naive batch,\nsuper-TAL overexpr.',
                  'B_naive_fed': 'B · naive +\n"unlimited" Tyr pulses',
                  'E_export_nosink': 'E · efflux eng.,\nno product removal',
                  'C_eng_batch': 'C · efflux + in-situ\nproduct removal'}
    keys = ['A_naive_batch', 'B_naive_fed', 'E_export_nosink', 'C_eng_batch']
    feeds_B = [3.0 * k for k in range(1, 14)]
    fig, axes = plt.subplots(2, 4, figsize=(15.5, 7.2), sharex='col')
    for j, key in enumerate(keys):
        ts, Ys = SOL[key]; d = series(ts, Ys)
        ax0 = axes[0, j]
        ax0.plot(ts, d['X'], color=C['X'])
        ax0.set_ylabel(LBL['X']); ax0.set_ylim(0, 9)
        am = ax0.twinx(); am.set_ylim(0, 1.02)
        am.plot(ts, d['m'], '--', color=C['m'], lw=1.2)
        am.set_ylabel(LBL['m'], color=C['m']); am.tick_params(axis='y', labelcolor=C['m'])
        ax0.set_title(scen_title[key], fontweight='bold', fontsize=9.5)
        ax1 = axes[1, j]
        skip = {'R': key != 'C_eng_batch', 'T': key.startswith(('E_', 'C_')),
                'Pe': key == 'C_eng_batch'}
        for var in ['T', 'P', 'Pe', 'R']:
            if skip.get(var, False):
                continue
            ax1.plot(ts, np.maximum(d[var] * 1e3, 1e-1), color=C[var], lw=1.5,
                     label=LBL[var])
        ax1.set_yscale('log'); ax1.set_ylim(1e-1, 2e5)
        ax1.set_ylabel('conc. (µM, log)')
        for ft in (feeds_B if key == 'B_naive_fed' else []):
            ax0.axvline(ft, color='0.82', ls=':', lw=1)
            ax1.axvline(ft, color='0.82', ls=':', lw=1)
        ax1.set_xlabel('time (h)')
    hl = [plt.Line2D([0], [0], color=C['X'], lw=2, label=LBL['X']),
          plt.Line2D([0], [0], color=C['m'], lw=1.5, ls='--', label=LBL['m']),
          plt.Line2D([0], [0], color=C['T'], lw=1.5, label=LBL['T']),
          plt.Line2D([0], [0], color=C['P'], lw=1.5, label=LBL['P']),
          plt.Line2D([0], [0], color=C['Pe'], lw=1.5, label=LBL['Pe']),
          plt.Line2D([0], [0], color=C['R'], lw=1.5, label=LBL['R'])]
    fig.legend(handles=hl, loc='upper center', bbox_to_anchor=(0.5, 0.995),
               ncol=6, frameon=False, fontsize=8)
    fig.tight_layout(rect=(0, 0, 1, 0.965))
    fig.savefig(outfile, dpi=150, bbox_inches='tight')
    print('figure saved:', outfile)

# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--scenario', choices=list(SCENARIOS) + ['all'], default='all')
    ap.add_argument('--tf', type=float, default=None)
    ap.add_argument('--outdir', default='.')
    ap.add_argument('--no-fig', action='store_true')
    ap.add_argument('--no-csv', action='store_true')
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    SOL = {}; rows = []
    names = [a.scenario] if a.scenario != 'all' else list(SCENARIOS)
    for n in names:
        op = dict(SCENARIOS[n]['op'])
        if a.tf: op['tf'] = a.tf
        ts, Ys = run_op(SCENARIOS[n]['cfg'], **op)
        SOL[n] = (ts, Ys)
        rows.append(summary_row(n, ts, Ys))
    hdr = ['scenario', 't_end', 'X_f', 'mu_avg', 'T_end_uM', 'P_int_max', 'Pe_end',
           'captured_R', 'm_min', 'pCA_ext_gL', 'pCA_total_gL']
    print('\n' + ('%-16s %6s %7s %8s %8s %7s %6s %5s %11s %11s' %
                  ('scenario', 'X_f', 'mu_avg', 'T_uM', 'P_intMax', 'Pe_end',
                   'R_cap', 'm_min', 'pCA_ext_gL', 'pCA_tot_gL')))
    for r in rows:
        print('%-16s %6.2f %7.3f %8.1f %8.1f %7.2f %6.1f %5.2f %11.2f %11.2f' %
              (r['scenario'], r['X_f'], r['mu_avg'], r['T_end_uM'], r['P_int_max'],
               r['Pe_end'], r['captured_R'], r['m_min'], r['pCA_ext_gL'], r['pCA_total_gL']))
    if not a.no_csv:
        with open(os.path.join(a.outdir, 'sim_summary.csv'), 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=hdr); w.writeheader(); w.writerows(rows)
        for n in SOL:
            ts, Ys = SOL[n]
            with open(os.path.join(a.outdir, 'traj_%s.csv' % n), 'w', newline='') as f:
                w = csv.writer(f); w.writerow(['t'] + NAMES)
                for t, row in zip(ts, Ys):
                    w.writerow([round(float(t), 4)] + [round(float(x), 6) for x in row])
        print('CSV saved in', a.outdir)
    if not a.no_fig and a.scenario == 'all':
        plot_all(SOL, os.path.join(a.outdir, 'fig_ode_sim.png'))
    return SOL

if __name__ == '__main__':
    main()
