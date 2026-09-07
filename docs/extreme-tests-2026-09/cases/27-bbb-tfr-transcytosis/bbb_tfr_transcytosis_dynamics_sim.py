#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bbb_tfr_transcytosis_dynamics_sim.py
=====================================
跨内皮 TfR 介导转胞吞（RMT）动力学仿真 —— 双特异性抗体脑递送审查配套脚本

Scope / 模型范围
   竞争网络（ODE，单位：pmol/g 脑、分钟、血浆 C_p [nM]=pmol/mL）：
    对流供料(脑血流 Q) -> 腔面膜结合(kon/koff by Kd) -> 网格蛋白内吞
    -> 内体酸化分选(释放: k_off 由*内体*pH 下 Kd 决定；MVB/溶酶体 vs 回收 vs 转胞吞)
    -> 基底侧胞吐释放入脑间质 -> 脑清除；+ 受体稳态合成与抗体驱动受体下调。

三类构造（对照 目标团队主张的 BsAb-01）:
   hi : 0.2 nM 双价、pH 非敏感 (Kd@pH5.5 = 0.2 nM)
   med: 100 nM  单价、pH 非敏感
   phs: 单价 pH 敏感 (Kd 7.4 = 5 nM；内体 pH~6 有效 Kd ≈ 1.4 uM -> 内体释放)

产物:
   fig1_receptor_downreg_transcytosis_timeseries.png
   fig2_dose_response_affinity_window.png
   fig3_affinity_dose_phase_diagram_3d.png
   fig4_endosomal_sorting_fate_incinerator.png
   summary_results.json
用法:  python bbb_tfr_transcytosis_dynamics_sim.py [--outdir DIR] [--no-figs]
"""

import os, sys, json, argparse
import numpy as np
from scipy.integrate import solve_ivp
from dataclasses import dataclass

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    _HAS_MPL = True
except Exception:
    _HAS_MPL = False
    plt = None

# ----------------------------------------------------------------------------- #
# 1. 速率常数折合与受体动力学参数
# ----------------------------------------------------------------------------- #
# on-flux(pmol/g/min) = KON_EFF * Cp(nM) * Rs(pmol/g)，KON_EFF=0.006 对应 kon~1e5 M^-1 s^-1；
# k_off(min^-1) = KON_EFF * Kd(nM)。
KON_EFF = 0.006

@dataclass
class Par:
    k_endR : float = 0.08     # 游离 TfR 组成型内吞
    k_endC : float = 0.10     # 表面 Ab-TfR 复合物内吞
    k_so   : float = 0.30     # 分选内体出口速率（滞留 ~3.3 min）
    k_rel  : float = 0.20     # 转胞吞囊泡-> 基底侧释放
    k_deg  : float = 0.06     # 溶酶体内抗体降解
    k_e    : float = 9.6e-4   # 脑间质消除（半衰期~12 h）
    PS_ns  : float = 1.0e-6   # 非特异性(胞旁)脑入流
    Q      : float = 0.60     # 脑血流 mL/min/g（对流供料上限）
    R0     : float = 1.2      # 循环腔面 TfR 池稳态设定 (pmol/g)
    k_homeo: float = 0.0012   # 受体合成(半衰期~10 h)补回 R0
    # ---- 内吞后“游离抗体”(已解离)的内体分选 ----
    frAb_T  : float = 0.020   # -> 转胞吞（脑）
    frAb_ret: float = 0.930   # -> 回收内体回血
    frAb_lys: float = 0.050   # -> 液相溶酶体
    # ---- 持久不解离复合物分选（单价默认）----
    frEn_lys: float = 0.68
    frEn_rec: float = 0.27
    frEn_T  : float = 0.05

def branches(P, bivalent):
    # 双价 TfR 臂诱导受体交联 -> 降解性(MVB/溶酶体)分流增强、回收/转胞吞削弱
    if bivalent:
        return dict(lys=0.92, rec=0.06, T=0.02)
    return dict(lys=P.frEn_lys, rec=P.frEn_rec, T=P.frEn_T)

# 状态向量索引
S = dict(Rs=0, Cs=1, En=2, Ef=3, Rf=4, T=5, B=6, LysAb=7,
         Rdeg=8, ADeg=9, Cap=10, Del=11)

def make_rhs(P, Cp_nM, Kd_sur_nM, Kd_end_nM, bivalent):
    koff_s = KON_EFF*Kd_sur_nM          # 腔面 pH7.4 解离
    koff_e = KON_EFF*Kd_end_nM          # 酸化内体(pH~5.5-6)解离 -> pH敏感性所在
    br = branches(P, bivalent)
    def rhs(t, y):
        Rs,Cs,En,Ef,Rf,T,B,LysAb,Rdeg,ADeg,Cap,Del = y
        on  = min(KON_EFF*Cp_nM*Rs, P.Q*Cp_nM)   # 对流供料上限
        off = koff_s*Cs
        rel = koff_e*En                          # 内体酸化触发释放
        eEnL = P.k_so*En*br['lys']; eEnR = P.k_so*En*br['rec']; eEnT = P.k_so*En*br['T']
        eEfT = P.k_so*Ef*P.frAb_T;  eEfR = P.k_so*Ef*P.frAb_ret; eEfL = P.k_so*Ef*P.frAb_lys
        syn  = max(0.0, P.k_homeo*(P.R0-(Rs+Cs)))
        dRs = -on + off - P.k_endR*Rs + P.k_so*Rf + eEnT + syn
        dCs = on - off - P.k_endC*Cs + eEnR
        dEn = P.k_endC*Cs - rel - P.k_so*En
        dEf = rel - P.k_so*Ef
        dRf = P.k_endR*Rs + rel - P.k_so*Rf
        dT  = eEnT + eEfT - P.k_rel*T
        dLysAb = eEnL + eEfL - P.k_deg*LysAb
        dB  = P.k_rel*T - P.k_e*B + P.PS_ns*Cp_nM
        dRdeg = eEnL
        dADeg = P.k_deg*LysAb
        dCap = P.k_endC*Cs
        dDel = P.k_rel*T
        return [dRs,dCs,dEn,dEf,dRf,dT,dB,dLysAb,dRdeg,dADeg,dCap,dDel]
    return rhs

def solve_construct(Cp_nM, Kd_sur_nM, Kd_end_nM, bivalent=False, T_h=72.0,
                    P=None, n_out=2401):
    P = P or Par()
    rhs = make_rhs(P, Cp_nM, Kd_sur_nM, Kd_end_nM, bivalent)
    y0 = np.zeros(12); y0[S['Rs']] = P.R0
    t_eval = np.linspace(0, T_h*60.0, n_out)
    sol = solve_ivp(rhs, (0, T_h*60.0), y0, t_eval=t_eval,
                    method='LSODA', rtol=1e-6, atol=1e-10, max_step=30)
    return sol.t, sol.y

def metrics(sol_t, sol_y, Cp_nM, T_h=72.0, P=None):
    P = P or Par()
    B = sol_y[S['B']]; Rs = sol_y[S['Rs']]
    idx48 = np.argmin(np.abs(sol_t-48*60))
    return dict(Kp48=B[idx48]/Cp_nM,
                AUC_brain=np.trapezoid(B, sol_t)/60.0,
                Rfrac_48=Rs[idx48]/P.R0, Rfrac_end=Rs[-1]/P.R0,
                B72=sol_y[S['B'],-1], Del_cum=sol_y[S['Del'],-1],
                DegAb_cum=sol_y[S['ADeg'],-1], Cap_cum=sol_y[S['Cap'],-1],
                Rs=sol_y[S['Rs']], t=sol_t)

# ----------------------------------------------------------------------------- #
# 2. 构造与样式
# ----------------------------------------------------------------------------- #
CONS = dict(hi=dict(kd_s=0.2, kd_e=0.2, bi=True),      # BsAb-01 主张构造
            med=dict(kd_s=100., kd_e=100., bi=False),
            phs=dict(kd_s=5., kd_e=1400., bi=False))    # 内体有效 Kd≈1.4 uM
C_HI, C_MED, C_PHS = '#c1121f', '#175faf', '#178f4a'
COLS = {'hi':C_HI,'med':C_MED,'phs':C_PHS}
MKS  = {'hi':'o','med':'s','phs':'^'}
LBL  = {'hi':'BsAb-01：0.2 nM 双价，pH非敏感',
        'med':'100 nM 单价，pH非敏感',
        'phs':'pH敏感型：5 nM (pH7.4)/~1.4 µM (pH6)'}

def _fonts():
    try:
        from matplotlib import font_manager as fm
        names = {f.name for f in fm.fontManager.ttflist}
        for c in ['PingFang SC','Heiti SC','Hiragino Sans GB','Songti SC',
                  'Noto Sans CJK SC','Arial Unicode MS','Microsoft YaHei']:
            if c in names: return [c]
    except Exception:
        pass
    return ['DejaVu Sans']

def _mpl():
    if not _HAS_MPL: return
    plt.rcParams.update({'font.family':'sans-serif',
        'font.sans-serif':_fonts()+['DejaVu Sans'],
        'axes.unicode_minus':False, 'font.size':9,
        'axes.labelsize':9.5, 'legend.fontsize':8, 'axes.titlesize':9.5})

# ----------------------------------------------------------------------------- #
# 3. 图 1-4
# ----------------------------------------------------------------------------- #
def fig_timeseries(DATA, out):
    _mpl()
    tc=DATA['tc']; P=Par()
    fig,axes=plt.subplots(3,2,figsize=(9.0,8.8))
    for col,Cp in enumerate([0.3,10.0]):
        for k in ['hi','med','phs']:
            dd=tc[Cp][k]; c=COLS[k]
            axes[0,col].plot(dd['t']/60, dd['Rs']/P.R0, color=c, lw=1.9, label=LBL[k])
            axes[1,col].plot(dd['t']/60, dd['B'], color=c, lw=1.9)
            axes[2,col].plot(dd['t']/60, np.maximum(dd['flux'],1e-8), color=c, lw=1.9)
        axes[0,col].set_ylim(0,1.06); axes[0,col].axhline(1,color='0.7',lw=0.8,ls=':')
        axes[1,col].set_yscale('log'); axes[1,col].set_ylim(1e-4,2)
        axes[2,col].set_yscale('log'); axes[2,col].set_ylim(1e-5,5e-2)
        axes[0,col].set_title('血浆 C$_p$ = %.1f nM'%Cp if Cp<1 else '血浆 C$_p$ = %.0f nM'%Cp)
        for r,a in zip(['腔面 TfR / TfR$_0$','脑实质抗体 B (pmol/g)',
                        '跨内皮递送速率 (pmol min$^{-1}$ g$^{-1}$)'],[axes[0,col],axes[1,col],axes[2,col]]):
            a.set_ylabel(r); a.set_xlim(0,72)
    for a in axes[2]: a.set_xlabel('时间 (h)')
    for i,ax in enumerate(axes.flat):
        ax.annotate('ABCDEF'[i],xy=(-0.2,1.02),xycoords='axes fraction',fontweight='bold',fontsize=11)
    h,l=axes[0,0].get_legend_handles_labels()
    fig.legend(h,l,loc='lower center',ncol=1,frameon=False,bbox_to_anchor=(0.5,-0.02),fontsize=8.5)
    fig.tight_layout(rect=(0,0.06,1,1))
    f=os.path.join(out,'fig1_receptor_downreg_transcytosis_timeseries.png')
    plt.savefig(f,bbox_inches='tight'); plt.close(fig); print('saved',f)

def fig_dose(DATA, out):
    _mpl(); scan=DATA['scan']
    fig,axes=plt.subplots(2,2,figsize=(9.2,7.4))
    ax=axes[0,0]
    for k in ['hi','med','phs']:
        r=scan[k]
        ax.plot([x['Cp'] for x in r],[100*x['Kp48'] for x in r],color=COLS[k],marker=MKS[k],ms=3.6,lw=1.7,label=LBL[k])
    ax.axhline(15,color='0.45',ls='--',lw=1.2); ax.axhline(0.1,color='0.45',ls=':',lw=1)
    ax.text(0.026,17.5,'宣称阈值 “脑/血比 > 15%”',fontsize=7.5,color='0.3')
    ax.text(0.026,0.13,'常规抗体 ~0.1% 基线',fontsize=7.5,color='0.3')
    ax.set_xscale('log'); ax.set_yscale('log'); ax.set_ylim(0.05,60)
    ax.set_xlabel('血浆游离抗体浓度 C$_p$ (nM)'); ax.set_ylabel('脑/血分配系数 Kp$_{48h}$ (%)')
    ax.set_title('(A) 脑实质分配系数随剂量变化')
    ax=axes[0,1]
    for k in ['hi','med','phs']:
        r=scan[k]; ax.plot([x['Cp'] for x in r],[x['AUC'] for x in r],color=COLS[k],marker=MKS[k],ms=3.6,lw=1.7)
    ax.set_xscale('log'); ax.set_yscale('log')
    ax.set_xlabel('血浆游离抗体浓度 C$_p$ (nM)'); ax.set_ylabel('脑暴露量 AUC$_{0-72h}$ (pmol·h/g)')
    ax.set_title('(B) 脑暴露总量（目标占位的真实度量）')
    ax=axes[1,0]
    for k in ['hi','med','phs']:
        r=scan[k]; ax.plot([x['Cp'] for x in r],[x['R48'] for x in r],color=COLS[k],marker=MKS[k],ms=3.6,lw=1.7)
    ax.axhline(0.5,color='0.7',ls='--',lw=1)
    ax.set_xscale('log'); ax.set_ylim(0,1.02)
    ax.set_xlabel('血浆游离抗体浓度 C$_p$ (nM)'); ax.set_ylabel('48 h 腔面 TfR 剩余分数')
    ax.set_title('(C) 受体下调 → 递送负反馈雪崩')
    ax=axes[1,1]
    j=int(np.argmin(np.abs(DATA['Cpg']-10.0))); kds=DATA['Kdg']
    ax.plot(kds,100*10**DATA['grid']['mono'][:,j],color='0.15',lw=1.8,label='单价 pH非敏感家族')
    ax.plot(kds,100*10**DATA['grid']['biv'][:,j],color='0.15',lw=1.8,ls='--',label='双价 pH非敏感家族')
    for k in ['hi','med','phs']:
        r=[x for x in scan[k] if abs(x['Cp']-10.)<1e-9][0]
        ax.plot({'hi':0.2,'med':100.,'phs':5.}[k],100*r['Kp48'],marker=MKS[k],ms=9,
                mfc=COLS[k],mec='white',mew=1.2,zorder=6,label=LBL[k])
    ax.set_xscale('log'); ax.set_yscale('log'); ax.set_ylim(1e-3,15)
    ax.set_xlabel('表面结合 Kd (nM)'); ax.set_ylabel('Kp$_{48h}$ (%)  @ C$_p$=10 nM')
    ax.set_title('(D) 亲和力窗口：转胞吞需要“可释放”结合')
    ax.legend(fontsize=6.3,loc='upper left',frameon=False)
    h,l=axes[0,0].get_legend_handles_labels()
    fig.legend(h,l,loc='lower center',ncol=1,frameon=False,bbox_to_anchor=(0.5,-0.03),fontsize=8.3)
    fig.tight_layout(rect=(0,0.07,1,1))
    f=os.path.join(out,'fig2_dose_response_affinity_window.png')
    plt.savefig(f,bbox_inches='tight'); plt.close(fig); print('saved',f)

def fig_phase3d(DATA, out):
    _mpl()
    from mpl_toolkits.mplot3d import Axes3D  # noqa
    Cpg,Kdg=DATA['Cpg'],DATA['Kdg']; Xg,Yg=np.meshgrid(Cpg,Kdg); scan=DATA['scan']
    def kp_log(k):
        r=[x for x in scan[k] if abs(x['Cp']-10.)<1e-9][0]; return np.log10(r['Kp48'])
    KDL={'hi':0.2,'med':100.,'phs':5.}
    fig=plt.figure(figsize=(12.5,6.3))
    for pi,(key,ttl) in enumerate([('mono','(A) 单价臂，pH 非敏感'),('biv','(B) 双价臂（受体交联），pH 非敏感')]):
        ax=fig.add_subplot(1,2,pi+1,projection='3d'); Z=DATA['grid'][key]
        surf=ax.plot_surface(np.log10(Xg),np.log10(Yg),Z,cmap='viridis',
                             norm=plt.Normalize(-3.3,-0.3),rcount=33,ccount=33,alpha=0.95,linewidth=0)
        ax.set_title(ttl,fontsize=10); ax.set_xlabel('log$_{10}$ C$_p$ (nM)',fontsize=8.5,labelpad=-2)
        ax.set_ylabel('log$_{10}$ Kd (nM)',fontsize=8.5,labelpad=-2); ax.set_zlabel('log$_{10}$ Kp$_{48h}$',fontsize=8.5,labelpad=-1)
        ax.view_init(elev=24,azim=-130)
        for axis in (ax.xaxis,ax.yaxis,ax.zaxis): axis.set_tick_params(labelsize=6)
        for k in ['hi','med','phs']:
            ax.scatter([1.0],[np.log10(KDL[k])],[kp_log(k)],s=55,color=COLS[k],
                       edgecolor='white',linewidth=1.1,depthshade=False,zorder=10)
        cb=fig.colorbar(surf,ax=ax,shrink=0.5,pad=0.05,aspect=22)
        cb.set_label('log$_{10}$ Kp$_{48h}$',fontsize=7.5); cb.ax.tick_params(labelsize=6.5)
    fig.tight_layout()
    f=os.path.join(out,'fig3_affinity_dose_phase_diagram_3d.png')
    plt.savefig(f,bbox_inches='tight',dpi=150); plt.close(fig); print('saved',f)

def fig_fate(DATA, out):
    _mpl(); P=Par()
    Cp=10.0; res={}
    for k,c in CONS.items():
        t,y=solve_construct(Cp,c['kd_s'],c['kd_e'],bivalent=c['bi'],T_h=72.0)
        Cap=y[S['Cap'],-1]; Deg=y[S['ADeg'],-1]; Del=y[S['Del'],-1]
        resid=y[S['Cs'],-1]+y[S['En'],-1]+y[S['Ef'],-1]+y[S['LysAb'],-1]+y[S['T'],-1]
        res[k]=dict(Deg=100*Deg/Cap,Del=100*Del/Cap,Ret=100*(Cap-Deg-Del-resid)/Cap,
                    Resid=100*resid/Cap,R=y[S['Rs'],-1]/P.R0)
    order=['hi','med','phs']
    names=['0.2 nM 双价\npH非敏感','100 nM 单价\npH非敏感','pH敏感型\n5 nM / ~1.4 μM']
    deg=[res[k]['Deg'] for k in order]; ret=[res[k]['Ret'] for k in order]
    dl=[res[k]['Del'] for k in order]; rr=[res[k]['Resid'] for k in order]
    fig,ax=plt.subplots(figsize=(7.6,4.8)); x=np.arange(3)
    ax.bar(x,deg,0.55,color='#59524b',label='内吞后于溶酶体被降解（焚化）')
    ax.bar(x,ret,0.55,bottom=deg,color='#aeb6bf',label='回收到管腔侧（回流入血）')
    ax.bar(x,dl,0.55,bottom=[a+b for a,b in zip(deg,ret)],color='#e0a800',label='转胞吞递送至脑实质')
    ax.bar(x,rr,0.55,bottom=[a+b+c for a,b,c in zip(deg,ret,dl)],color='#d8d3b8',label='仍存留细胞内')
    for i,(a,b,c) in enumerate(zip(deg,ret,dl)):
        if a>8: ax.text(x[i],a/2,'%.0f%%'%a,ha='center',va='center',color='w',fontsize=9,fontweight='bold')
        if b>8: ax.text(x[i],a+b/2,'%.0f%%'%b,ha='center',va='center',color='0.15',fontsize=8)
        if c>3: ax.text(x[i],a+b+c/2,'%.0f%%'%c,ha='center',va='center',color='0.15',fontsize=8)
    for i,k in enumerate(order):
        ax.text(x[i],101,'72 h 表面 TfR 残余 = %.0f%%'%(100*res[k]['R']),ha='center',fontsize=8.5,
                color=COLS[k],fontweight='bold')
    ax.set_xticks(x); ax.set_xticklabels(names,fontsize=9); ax.set_ylim(0,112)
    ax.set_ylabel('占内吞抗体总量的比例 (%)')
    ax.set_title('内吞后分选命运与受体残余（C$_p$ = 10 nM，72 h）')
    ax.legend(loc='upper left',fontsize=7.5,frameon=False)
    ax.spines[['top','right']].set_visible(False)
    fig.tight_layout()
    f=os.path.join(out,'fig4_endosomal_sorting_fate_incinerator.png')
    plt.savefig(f,bbox_inches='tight'); plt.close(fig); print('saved',f)

# ----------------------------------------------------------------------------- #
# 4. 数据准备
# ----------------------------------------------------------------------------- #
def build_data(T_h=72.0):
    P=Par(); DATA={}; Cps=np.array([0.03,0.05,0.1,0.2,0.3,0.5,1.,2.,3.,5.,10.,20.,30.,50.,100.])
    for Cp in [0.3,10.0]:
        d={}
        for k,c in CONS.items():
            t,y=solve_construct(Cp,c['kd_s'],c['kd_e'],bivalent=c['bi'],T_h=T_h)
            d[k]=dict(t=t,Rs=y[S['Rs']],B=y[S['B']],flux=P.k_rel*y[S['T']],ADeg=y[S['ADeg']],Del=y[S['Del']])
        DATA.setdefault('tc',{})[Cp]=d
    scan={}
    for k,c in CONS.items():
        rows=[]
        for Cp in Cps:
            t,y=solve_construct(Cp,c['kd_s'],c['kd_e'],bivalent=c['bi'],T_h=T_h)
            m=metrics(t,y,Cp); cap=m['Cap_cum']
            B48=y[S['B']][np.argmin(np.abs(t-48*60))]
            rows.append(dict(Cp=Cp,Kp48=m['Kp48'],AUC=m['AUC_brain'],R48=m['Rfrac_48'],
                             B48=B48,DelFrac=m['Del_cum']/cap,DegFrac=m['DegAb_cum']/cap))
        scan[k]=rows
    Cpg=np.logspace(-2,2,33); Kdg=np.logspace(-1.5,3.5,33); grid={}
    for bi,key in [(False,'mono'),(True,'biv')]:
        Z=np.full((len(Kdg),len(Cpg)),np.nan)
        for i,Kd in enumerate(Kdg):
            for j,Cp in enumerate(Cpg):
                t,y=solve_construct(Cp,Kd,Kd,bivalent=bi,T_h=T_h); m=metrics(t,y,Cp)
                Z[i,j]=np.log10(max(m['Kp48'],1e-6))
        grid[key]=Z
    DATA.update(Cpg=Cpg,Kdg=Kdg,grid=grid,scan=scan)
    return DATA

def main():
    ap=argparse.ArgumentParser(description='BBB TfR transcytosis dynamics simulation')
    ap.add_argument('--outdir',default='.',help='output directory')
    ap.add_argument('--no-figs',action='store_true',help='skip figure generation')
    ap.add_argument('--T',type=float,default=72.0,help='simulation horizon (h)')
    a=ap.parse_args(); os.makedirs(a.outdir,exist_ok=True)
    DATA=build_data(T_h=a.T)
    rep=[]
    for k in ['hi','med','phs']:
        for row in DATA['scan'][k]:
            rep.append(dict(construct=k,Cp=row['Cp'],Kp48_pct=100*row['Kp48'],AUC=row['AUC'],
                            R48=row['R48'],B48=row['B48'],DelFrac_pct=100*row['DelFrac'],
                            DegFrac_pct=100*row['DegFrac']))
    with open(os.path.join(a.outdir,'summary_results.json'),'w') as f: json.dump(rep,f,indent=1)
    print('='*104)
    print('Cp(nM) | hi: Kp48%% / R48 / AUC   | med: Kp48%% / R48 / AUC   | phs: Kp48%% / R48 / AUC')
    print('-'*104)
    for row in DATA['scan']['hi']:
        Cp=row['Cp']
        def g(k,f):
            r=[x for x in DATA['scan'][k] if abs(x['Cp']-Cp)<1e-9][0]
            return {'Kp':100*r['Kp48'],'R':r['R48'],'A':r['AUC']}[f]
        print('%6.2f | %6.2f%% / %.2f / %6.2f | %6.2f%% / %.2f / %6.2f | %6.2f%% / %.2f / %6.2f'
              %(Cp,g('hi','Kp'),g('hi','R'),g('hi','A'),
                g('med','Kp'),g('med','R'),g('med','A'),
                g('phs','Kp'),g('phs','R'),g('phs','A')))
    print('='*104)
    if not a.no_figs and _HAS_MPL:
        fig_timeseries(DATA,a.outdir); fig_dose(DATA,a.outdir)
        fig_phase3d(DATA,a.outdir); fig_fate(DATA,a.outdir)
    print('done. outputs ->',a.outdir)

if __name__=='__main__':
    sys.exit(main())
