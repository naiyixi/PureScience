#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TNIK-targeted de novo generative audit -- "STE20-family false-positive selectivity and
hinge micro-environment collapse" review.
============================================================================================
Audits a hypothetical report claiming that a graph-generative hit (Lead-01, imidazo[1,2-a]-
pyrazine) achieves >1000x TNIK-over-MAP4K4/MINK1 selectivity from hinge double-H-bond to the
Cys108 main chain plus a rigid 3-CF3-phenyl in the back pocket, docked on PDB 5AX9/2X7F.

What this script reproduces (all figures & numbers offline; data embedded from UniProt and
from PDB 5AX9 / 2X7F analysed in the parent study):
  1. Kinase-domain (UniProt 25-289) residue micro-environment difference matrix   -> fig1
  2. Static-conformer bias: P-loop displacement 5AX9 vs 2X7F (same protein)        -> fig2
  3. Molecule comparison (Lead-01 reconstruction / real 5AX9 & 2X7F ligands /      -> fig3
     subtype-vector redesign)
  4. Subtype-discrimination budget vs the 1000x (=4.13 kcal/mol) requirement       -> fig4
  5. Rotamer-flexibility scoring & geometry-guided generative loss re-formulation  -> stdout tables

Requirements : numpy, matplotlib (figures 1,2,4); rdkit (figure 3).
Run          : python tnik_kinase_selectivity_generative_audit.py [--no-figures]
"""
import os, sys, math, json
import numpy as np

# ============================ EMBEDDED DATA ============================
UP_DOM_START = 25            # UniProt kinase-domain start for all three paralogs
SEQUENCES = {
    "TNIK":   "FELVELVGNGTYGQVYKGRHVKTGQLAAIKVMDVTGDEEEEIKQEINMLKKYSHHRNIATYYGAFIKKNPPGMDDQLWLVMEFCGAGSVTDLIKNTKGNTLKEEWIAYICREILRGLSHLHQHKVIHRDIKGQNVLLTENAEVKLVDFGVSAQLDRTVGRRNTFIGTPYWMAPEVIACDENPDATYDFKSDLWSLGITAIEMAEGAPPLCDMHPMRALFLIPRNPAPRLKSKKWSKKFQSFIESCLVKNHSQRPATEQLMKHPFI",   # UniProt Q9UKE5, domain 25-289
    "MAP4K4": "FELVEVVGNGTYGQVYKGRHVKTGQLAAIKVMDVTEDEEEEIKLEINMLKKYSHHRNIATYYGAFIKKSPPGHDDQLWLVMEFCGAGSITDLVKNTKGNTLKEDWIAYISREILRGLAHLHIHHVIHRDIKGQNVLLTENAEVKLVDFGVSAQLDRTVGRRNTFIGTPYWMAPEVIACDENPDATYDYRSDLWSCGITAIEMAEGAPPLCDMHPMRALFLIPRNPPPRLKSKKWSKKFFSFIEGCLVKNYMQRPSTEQLLKHPFI",     # UniProt O95819, domain 25-289
    "MINK1":  "FELVEVVGNGTYGQVYKGRHVKTGQLAAIKVMDVTEDEEEEIKQEINMLKKYSHHRNIATYYGAFIKKSPPGNDDQLWLVMEFCGAGSVTDLVKNTKGNALKEDCIAYICREILRGLAHLHAHKVIHRDIKGQNVLLTENAEVKLVDFGVSAQLDRTVGRRNTFIGTPYWMAPEVIACDENPDATYDYRSDIWSLGITAIEMAEGAPPLCDMHPMRALFLIPRNPPPRLKSKKWSKKFIDFIDTCLIKTYLSRPPTEQLLKFPFI",   # UniProt Q8N4C8, domain 25-289
}
# 5AX9 . 4KT ATP-contact shell (UniProt numbering), all 100% conserved across the 3 paralogs
SHELL45 = [31, 33, 34, 39, 52, 54, 69, 105, 106, 107, 108, 109, 111, 112, 115, 157, 158, 160, 170, 171]
SHELL60 = [30, 31, 32, 33, 34, 35, 39, 41, 52, 54, 69, 73, 83, 103, 105, 106, 107, 108, 109, 110, 111, 112, 115, 157, 158, 160, 170, 171, 172]
CONTACT_MIN = {'30': 5.64, '31': 3.44, '32': 5.22, '33': 4.07, '34': 4.29, '35': 5.73, '39': 3.7, '41': 5.81, '52': 3.42, '54': 3.32, '69': 3.91, '73': 5.65, '83': 5.05, '103': 4.82, '105': 3.73, '106': 3.24, '107': 3.54, '108': 2.84, '109': 3.18, '110': 4.9, '111': 3.8, '112': 4.48, '115': 3.21, '157': 3.75, '158': 4.43, '160': 3.23, '170': 3.49, '171': 3.54, '172': 4.86}
# per-residue C-alpha displacement (A) after core superposition, 5AX9.4KT vs 2X7F.824
DISP5_2 = {'13': 4.898, '14': 3.262, '15': 4.156, '16': 2.884, '17': 2.517, '18': 0.971, '19': 0.581, '20': 0.652, '21': 0.84, '22': 1.042, '23': 1.277, '24': 1.022, '25': 0.888, '26': 0.968, '27': 0.974, '28': 0.938, '29': 0.832, '30': 1.027, '31': 0.637, '32': 1.615, '33': 1.513, '34': 4.029, '35': 3.578, '36': 5.321, '37': 2.369, '38': 0.139, '39': 0.702, '40': 0.853, '41': 1.067, '42': 1.122, '43': 0.818, '44': 0.904, '45': 1.735, '46': 2.075, '47': 1.709, '48': 1.187, '49': 0.899, '50': 1.019, '51': 1.065, '52': 0.751, '53': 0.758, '54': 0.597, '55': 0.628, '56': 0.646, '57': 0.898, '58': 1.48, '59': 1.281, '60': 1.141, '61': 1.349, '62': 0.935, '63': 1.157, '64': 1.14, '65': 0.43, '66': 0.853, '67': 1.168, '68': 1.142, '69': 1.049, '70': 1.35, '71': 1.494, '72': 1.35, '73': 1.349, '74': 1.7, '75': 1.504, '76': 1.07, '77': 1.201, '78': 0.935, '79': 0.719, '80': 0.571, '81': 0.29, '82': 0.521, '83': 0.6, '84': 1.169, '85': 1.202, '86': 1.316, '87': 1.231, '88': 0.56, '89': 0.517, '90': 0.424, '91': 0.504, '92': 1.088, '93': 2.44, '94': 4.415, '95': 5.62, '96': 6.938, '97': 5.397, '98': 2.467, '99': 1.266, '100': 0.538, '101': 0.511, '102': 0.453, '103': 0.414, '104': 0.66, '105': 0.881, '106': 1.258, '107': 0.933, '108': 0.797, '109': 1.088, '110': 0.888, '111': 0.866, '112': 0.72, '113': 0.629, '114': 0.708, '115': 0.877, '116': 0.769, '117': 0.608, '118': 0.942, '119': 1.39, '120': 1.258, '121': 2.047, '122': 1.13, '123': 0.77, '124': 0.73, '125': 0.825, '126': 1.182, '127': 1.073, '128': 0.966, '129': 0.822, '130': 0.546, '131': 0.665, '132': 0.725, '133': 0.601, '134': 0.506, '135': 0.758, '136': 0.501, '137': 0.387, '138': 0.734, '139': 0.66, '140': 0.399, '141': 0.815, '142': 1.142, '143': 0.793, '144': 1.031, '145': 1.464, '146': 1.504, '147': 1.451, '148': 1.722, '149': 1.493, '150': 1.462, '151': 1.009, '152': 1.254, '153': 1.136, '154': 0.686, '155': 0.389, '156': 0.183, '157': 0.806, '158': 0.677, '159': 0.246, '160': 0.467, '161': 0.506, '162': 0.729, '163': 1.053, '164': 1.016, '165': 0.689, '166': 0.529, '167': 0.27, '168': 0.306, '169': 0.608, '170': 0.886, '171': 1.39, '172': 1.235, '173': 1.522, '174': 1.556, '175': 1.156, '190': 1.452, '191': 1.109, '192': 1.223, '193': 0.967, '194': 0.991, '195': 1.044, '196': 1.175, '197': 1.333, '198': 1.634, '199': 1.557, '200': 1.523, '201': 4.782, '202': 6.759, '203': 6.899, '204': 4.328, '206': 3.54, '207': 4.836, '208': 5.976, '209': 5.744, '210': 5.203, '211': 2.589, '212': 1.559, '213': 1.548, '214': 1.452, '215': 1.127, '216': 1.172, '217': 1.055, '218': 0.805, '219': 0.764, '220': 0.839, '221': 0.498, '222': 0.381, '223': 0.524, '224': 0.407, '225': 0.184, '226': 0.265, '227': 0.307, '228': 0.397, '229': 0.297, '230': 0.127, '231': 0.168, '232': 0.339, '233': 0.313, '234': 0.411, '235': 0.452, '236': 0.606, '237': 0.925, '238': 1.252, '239': 1.45, '240': 1.003, '241': 1.002, '242': 1.382, '243': 1.338, '244': 0.996, '245': 0.907, '246': 1.151, '247': 1.011, '248': 0.936, '249': 0.861, '250': 0.705, '251': 0.713, '252': 0.717, '253': 0.58, '254': 1.02, '255': 0.674, '256': 1.454, '257': 1.151, '258': 1.137, '259': 1.512, '260': 1.779, '261': 1.611, '262': 1.173, '263': 1.197, '264': 1.499, '265': 1.2, '266': 1.038, '267': 1.435, '268': 1.568, '269': 1.347, '270': 1.236, '271': 1.303, '272': 1.291, '273': 1.937, '274': 1.94, '275': 2.103, '276': 2.131, '277': 1.742, '278': 1.593, '279': 1.684, '280': 1.656, '281': 1.85, '282': 1.546, '283': 1.63, '284': 1.724, '285': 1.692, '286': 1.734, '287': 1.847, '288': 1.402, '289': 1.232, '290': 0.962, '291': 1.56, '292': 1.454, '293': 1.281, '294': 0.814, '295': 1.072, '296': 1.36, '297': 1.751, '298': 1.29, '299': 0.795, '300': 1.249, '301': 1.167, '302': 1.079, '303': 1.202, '304': 1.361, '305': 1.375, '306': 1.004, '307': 1.25}
# pocket geometry from 5AX9 (real coordinates): hinge H-bond centroid, ligand centroid,
# 4KT distal-arm centroid, and side-chain centroids of conserved / variable residues
POCKET = {'105': {'aa': 'M', 'ca': [-5.440000057220459, -51.40999984741211, -21.760000228881836], 'sc': [-5.409999847412109, -51.70000076293945, -24.700000762939453]}, '106': {'aa': 'E', 'ca': [-8.989999771118164, -50.86000061035156, -20.540000915527344], 'sc': [-10.5600004196167, -47.939998626708984, -21.06999969482422]}, '108': {'aa': 'C', 'ca': [-14.420000076293945, -52.119998931884766, -23.93000030517578], 'sc': [-13.59000015258789, -50.63999938964844, -25.06999969482422]}, '109': {'aa': 'G', 'ca': [-17.100000381469727, -54.689998626708984, -23.15999984741211], 'sc': None}, '112': {'aa': 'S', 'ca': [-16.329999923706055, -52.56999969482422, -31.93000030517578], 'sc': [-15.65999984741211, -53.560001373291016, -33.40999984741211]}, '115': {'aa': 'D', 'ca': [-19.780000686645508, -55.560001373291016, -34.290000915527344], 'sc': [-17.950000762939453, -56.65999984741211, -33.04999923706055]}, '54': {'aa': 'K', 'ca': [-2.559999942779541, -57.290000915527344, -27.0], 'sc': [-1.7400000095367432, -55.150001525878906, -30.09000015258789]}, '69': {'aa': 'E', 'ca': [3.359999895095825, -48.630001068115234, -30.06999969482422], 'sc': [1.3600000143051147, -51.25, -30.65999984741211]}, '30': {'aa': 'L', 'ca': [-9.520000457763672, -64.4000015258789, -27.649999618530273], 'sc': [-8.289999961853027, -64.8499984741211, -29.899999618530273]}, '68': {'aa': 'Q', 'ca': [6.900000095367432, -47.2400016784668, -30.34000015258789], 'sc': [6.150000095367432, -45.33000183105469, -32.150001525878906]}, '113': {'aa': 'V', 'ca': [-18.610000610351562, -50.459999084472656, -34.11000061035156], 'sc': [-18.559999465942383, -48.58000183105469, -34.68000030517578]}, '117': {'aa': 'I', 'ca': [-23.31999969482422, -52.869998931884766, -37.31999969482422], 'sc': [-21.959999084472656, -51.72999954223633, -38.91999816894531]}, '129': {'aa': 'W', 'ca': [-26.1299991607666, -42.720001220703125, -33.630001068115234], 'sc': [-28.209999084472656, -46.099998474121094, -32.27000045776367]}, '134': {'aa': 'C', 'ca': [-18.3799991607666, -39.54999923706055, -35.40999984741211], 'sc': [-19.149999618530273, -39.630001068115234, -37.34000015258789]}, '__ligand_centroid__': [-12.0600004196167, -55.90999984741211, -28.729999542236328], '__hinge_hbond__': [-14.25, -53.29999923706055, -24.309999465942383], '__4kt_arm_centroid__': [-10.850000381469727, -56.34000015258789, -30.639999389648438]}
MOLECULES = {'lead01': 'Nc1cn2c(-c3cccc(C(F)(F)F)c3)cnc2cn1', 'mol4kt': 'COc1ccc(C#N)cc1-c1ccnc(Nc2ccc(N3CCOCC3)c(OC)c2)c1', 'mol824': 'O=C1NC(=O)c2c1c(-c1ccccc1)cc1[nH]c3ccc(O)cc3c21', 'lead02': 'NCCNC(=O)c1ccc(-c2cnc3cnc(N)cn23)cc1C(F)(F)F'}
# reach of each variable residue (closest atom distance to 4KT) in 5AX9; None = not observed
REACH = {'30': {'tn': 'L', 'm4': 'V', 'mk': 'V', 'min': 5.64}, '60': {'tn': 'G', 'm4': 'E', 'mk': 'E', 'min': 19.47}, '68': {'tn': 'Q', 'm4': 'L', 'mk': 'Q', 'min': 10.75}, '93': {'tn': 'N', 'm4': 'S', 'mk': 'S', 'min': 20.77}, '97': {'tn': 'M', 'm4': 'H', 'mk': 'N', 'min': 21.57}, '113': {'tn': 'V', 'm4': 'I', 'mk': 'V', 'min': 7.98}, '117': {'tn': 'I', 'm4': 'V', 'mk': 'V', 'min': 9.49}, '124': {'tn': 'T', 'm4': 'T', 'mk': 'A', 'min': 15.84}, '128': {'tn': 'E', 'm4': 'D', 'mk': 'D', 'min': 20.84}, '129': {'tn': 'W', 'm4': 'W', 'mk': 'C', 'min': 14.9}, '134': {'tn': 'C', 'm4': 'S', 'mk': 'C', 'min': 17.45}, '142': {'tn': 'S', 'm4': 'A', 'mk': 'A', 'min': 18.1}, '146': {'tn': 'Q', 'm4': 'I', 'mk': 'A', 'min': 19.74}, '148': {'tn': 'K', 'm4': 'H', 'mk': 'K', 'min': 17.76}, '212': {'tn': 'F', 'm4': 'Y', 'mk': 'Y', 'min': 19.23}, '213': {'tn': 'K', 'm4': 'R', 'mk': 'R', 'min': 21.13}, '216': {'tn': 'L', 'm4': 'L', 'mk': 'I', 'min': 18.9}, '219': {'tn': 'L', 'm4': 'C', 'mk': 'L', 'min': 16.68}, '250': {'tn': 'A', 'm4': 'P', 'mk': 'P', 'min': 27.42}, '263': {'tn': 'Q', 'm4': 'F', 'mk': 'I', 'min': 27.69}, '264': {'tn': 'S', 'm4': 'S', 'mk': 'D', 'min': 28.19}, '267': {'tn': 'E', 'm4': 'E', 'mk': 'D', 'min': 26.72}, '268': {'tn': 'S', 'm4': 'G', 'mk': 'T', 'min': 26.12}, '271': {'tn': 'V', 'm4': 'V', 'mk': 'I', 'min': 26.61}, '273': {'tn': 'N', 'm4': 'N', 'mk': 'T', 'min': 28.89}, '274': {'tn': 'H', 'm4': 'Y', 'mk': 'Y', 'min': 26.19}, '275': {'tn': 'S', 'm4': 'M', 'mk': 'L', 'min': 29.16}, '276': {'tn': 'Q', 'm4': 'Q', 'mk': 'S', 'min': 30.31}, '279': {'tn': 'A', 'm4': 'S', 'mk': 'P', 'min': 25.16}, '284': {'tn': 'M', 'm4': 'L', 'mk': 'L', 'min': 21.27}, '286': {'tn': 'H', 'm4': 'H', 'mk': 'F', 'min': 27.54}}

# ============================ descriptor helpers ============================
VOL = {"G":60.0,"A":88.6,"S":89.0,"T":116.1,"C":108.5,"V":140.0,"P":112.7,"L":166.7,"I":166.7,
       "M":162.9,"D":111.1,"E":138.4,"N":114.1,"Q":143.8,"K":168.6,"R":173.4,"H":153.2,
       "F":189.9,"Y":193.6,"W":227.8}
HYD = {"A":1.8,"R":-4.5,"N":-3.5,"D":-3.5,"C":2.5,"Q":-3.5,"E":-3.5,"G":-0.4,"H":-3.2,"I":4.5,
       "L":3.8,"K":-3.9,"M":1.9,"F":2.8,"P":-1.6,"S":-0.8,"T":-0.7,"W":-0.9,"Y":-1.3,"V":4.2}
CHG = {"D":-1,"E":-1,"K":1,"R":1}
ARO = {"F","Y","W","H"}; POL = {"S","T","N","Q","Y","H"}
CHI = {"G":0,"A":0,"V":1,"L":2,"I":2,"P":1,"S":1,"T":1,"C":1,"M":3,"F":2,"Y":2,"W":2,
       "N":2,"Q":3,"D":1,"E":3,"K":4,"R":4,"H":2}
def _desc(aa):
    return (VOL[aa]/250., HYD[aa]/6., CHG.get(aa,0.), 1. if aa in ARO else 0., .5 if aa in POL else 0.)
def physdist(a,b):
    da,db=_desc(a),_desc(b)
    return math.sqrt(sum((x-y)**2 for x,y in zip(da,db)))

def variable_positions():
    out=[]
    for p,(a,b,c) in enumerate(zip(SEQUENCES["TNIK"],SEQUENCES["MAP4K4"],SEQUENCES["MINK1"]),start=1):
        if not (a==b==c):
            out.append(dict(dom=p, up=p+24, tnik=a, m4k4=b, mink=c,
                            d_tm4=round(physdist(a,b),3), d_tmn=round(physdist(a,c),3)))
    return out

def npy_variant():
    return None

# ============================ figures ============================
def fig1(path="fig1_microenv_diff_matrix.png"):
    import numpy as np
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap
    seqs=[SEQUENCES[k] for k in ("TNIK","MAP4K4","MINK1")]
    M=np.zeros((3,265))
    for i in range(3):
        for j in range(i+1,3):
            pass
    pairs=[(0,1),(0,2),(1,2)]
    for i,(a,b) in enumerate(pairs):
        for p in range(265):
            M[i,p]=physdist(seqs[a][p],seqs[b][p])
    cols=variable_positions()
    fig,ax=plt.subplots(figsize=(13.5,3.8))
    cmap=LinearSegmentedColormap.from_list("mec",["#ffffff","#fde0dd","#f7a08a","#d7301f","#67001f"])
    im=ax.imshow(M,aspect="auto",cmap=cmap,vmin=0,vmax=float(max(M.max(),0.05)),extent=[0.5,265.5,3.6,-1.0])
    ax.set_yticks([0,1,2]); ax.set_yticklabels(["TNIK vs MAP4K4","TNIK vs MINK1","MAP4K4 vs MINK1"])
    for c in cols: ax.plot(c["dom"],3.33,marker="|",ms=4,color="#444444",mew=.9)
    for u in SHELL60: ax.plot(u-24,-0.30,marker="|",ms=5,color="#3182bd",mew=1.3)
    for u in SHELL45: ax.plot(u-24,-0.50,marker="|",ms=5,color="#111111",mew=1.3)
    ax.plot([],[],marker="|",ms=6,color="#444444",label="variable positions")
    ax.plot([],[],marker="|",ms=6,color="#3182bd",label="ATP-contact shell 4.5-6.0 A")
    ax.plot([],[],marker="|",ms=6,color="#111111",label="ATP-contact shell <=4.5 A (5AX9.4KT) - 100% conserved")
    ax.axvspan(1.5,21.5,ymin=.905,ymax=1,color="#bdd7e7",lw=0,alpha=.9)
    ax.axvspan(79.5,89.5,ymin=.905,ymax=1,color="#ffd966",lw=0,alpha=.95)
    ax.text(11,3.02,"P-loop",fontsize=6,ha="center")
    ax.text(84,3.02,"gatekeeper M105 / hinge Cys108",fontsize=6,ha="center")
    for domlab,txt in [(15,"Gly-rich"),(28,"K54 (VAIK)"),(60,"aC E69"),(148,"DFG"),(173,"APE")]:
        ax.text(domlab-0.5,3.35,txt,rotation=90,fontsize=5.4,va="bottom",color="#333333")
    ax.annotate("only near-pocket variable site: dom6 / UniProt30 L->V\n(P-loop beta1 edge, 5.64 A from ligand - conservative)",
                xy=(6,0),xytext=(18,2.5),fontsize=6.3,color="#8c2d04",
                arrowprops=dict(arrowstyle="->",lw=.7,color="#8c2d04"))
    ticks=list(range(10,270,25)); ax.set_xticks(ticks); ax.set_xticklabels([str(t+24) for t in ticks])
    ax.set_xlabel("kinase-domain position (UniProt 25-289); top ticks = variable columns; lower ticks = ATP-contact shell")
    ax.set_title("Per-residue micro-environment difference matrix - TNIK / MAP4K4 / MINK1 kinase domains (STE20 . GCK-IV)\n"
                 "color = side-chain physicochemical distance; white columns = 100% identical",
                 fontsize=8.8)
    cbar=fig.colorbar(im,ax=ax,fraction=0.028,pad=0.015); cbar.set_label("micro-environment distance",fontsize=7)
    ax.legend(loc="upper left",bbox_to_anchor=(1.005,0.6),fontsize=6.2,frameon=False)
    plt.tight_layout(); plt.savefig(path,dpi=200); plt.close(fig)

def fig2(path="fig2_ploop_static_bias.png"):
    import numpy as np
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    ups=np.array(sorted(int(k) for k in DISP5_2)); vals=np.array([DISP5_2[str(u)] for u in ups])
    PL=list(range(28,51)); HG=list(range(103,116)); ACT=list(range(140,211))
    def seg(z):
        v=np.array([vals[i] for i,u in enumerate(ups) if u in z])
        return (math.sqrt((v**2).mean()), v.max(), len(v)) if len(v) else (0,0,0)
    core=list(range(40,251))
    fig,axes=plt.subplots(2,1,figsize=(11,6),gridspec_kw={"height_ratios":[2.2,1]})
    ax=axes[0]
    ax.plot(ups,vals,lw=.8,color="#444444")
    ax.fill_between(ups,vals,where=np.isin(ups,PL),color="#e6550d",alpha=.28,step="pre",label="P-loop / Gly-rich (28-50)")
    ax.fill_between(ups,vals,where=np.isin(ups,ACT),color="#9e9ac8",alpha=.25,step="pre",label="activation segment (140-210)")
    ax.fill_between(ups,vals,where=np.isin(ups,HG),color="#31a354",alpha=.30,step="pre",label="hinge / gatekeeper (103-115)")
    for u in [54,108,151,171]: ax.axvline(u,color="#bbbbbb",lw=.5,ls=":")
    ax.set_ylabel("C-alpha displacement after core fit (A)\n5AX9.4KT vs 2X7F.824 (both TNIK)")
    for (x,t) in [(54,"K54"),(108,"Cys108"),(151,"HRD"),(171,"DFG")]:
        ax.text(x,float(vals.max())*0.92,t,fontsize=6,ha="center")
    ax.set_title("Conformational plasticity of the TNIK ATP site across two co-crystal complexes (same kinase, two inhibitors)\n"
                 "P-loop moves ~1.5-2x more than the rigid hinge -> docking 'selectivity' can be a static-snapshot artifact",
                 fontsize=9)
    ax.set_xlim(20,290); ax.legend(fontsize=6.5,loc="upper left",frameon=False)
    ax2=axes[1]
    def s2(z):
        v=np.array([vals[i] for i,u in enumerate(ups) if u in z]); return math.sqrt((v**2).mean()) if len(v) else 0
    labels=["core (fit)","hinge+gatekeeper\n103-115","P-loop\n28-50","activation\n140-210","all mapped"]
    vals2=[s2([u for u in core if u in ups]),seg(HG)[0],seg(PL)[0],seg(ACT)[0],s2(list(ups))]
    cols2=["#9ecae1","#31a354","#e6550d","#9e9ac8","#777777"]
    bars=ax2.bar(range(len(labels)),vals2,color=cols2,width=.62)
    for b,v in zip(bars,vals2): ax2.text(b.get_x()+b.get_width()/2,v+0.02,f"{v:.2f} A",ha="center",fontsize=7)
    ax2.set_xticks(range(len(labels))); ax2.set_xticklabels(labels,fontsize=7)
    ax2.set_ylabel("segment C-alpha RMSD (A)"); ax2.set_ylim(0,max(vals2)*1.35)
    ax2.set_title("Same protein, two co-crystals: P-loop & activation segment move ~2x more than the rigid hinge (core 1.41 A).",
                  fontsize=8,loc="left")
    plt.tight_layout(); plt.savefig(path,dpi=200); plt.close(fig)

def fig3(path="fig3_molecule_comparison.png"):
    try:
        from rdkit import Chem
        from rdkit.Chem import Draw
        import numpy as np
        import matplotlib; matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception as e:
        print("fig3 skipped (rdkit unavailable):",e); return
    def arr(smi,w=440,h=320):
        m=Chem.MolFromSmiles(smi)
        return np.asarray(Draw.MolToImage(m,size=(w,h),kekulize=True))
    panels=[("A","Lead-01 (reconstruction; hinge + 3-CF3-phenyl back pocket)",MOLECULES["lead01"]),
            ("B","4KT - authentic 5AX9 co-crystal ligand",MOLECULES["mol4kt"]),
            ("C","824 - authentic 2X7F co-crystal ligand",MOLECULES["mol824"]),
            ("D","Lead-02 (subtype-vector redesign; rim arm)",MOLECULES["lead02"])]
    fig,axes=plt.subplots(2,2,figsize=(11,9.6))
    for ax,(tag,title,smi) in zip(axes.ravel(),panels):
        ax.imshow(arr(smi)); ax.axis("off"); ax.set_title(f"({tag}) {title}",fontsize=8,loc="left")
    fig.suptitle("De novo generative structure comparison - conserved ATP-site chemotypes vs subtype-vector redesign (RDKit 2D)",
                 fontsize=10,y=1.0)
    plt.tight_layout(rect=[0,0.02,1,0.98]); plt.savefig(path,dpi=180); plt.close(fig)

def fig4(path="fig4_subtype_budget.png"):
    import numpy as np
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    pts=[]
    for up,r in REACH.items():
        if r["min"] is None: continue
        up=int(up); dom=up-24
        pts.append(dict(up=up,dom=dom,x=r["min"],y=physdist(r["tn"],r["m4"]),
                        lab=f"{r['tn']}{r['m4']}@{up}",diff=(r["tn"]!=r["m4"])))
    pts.sort(key=lambda z:z["x"])
    for p in pts: p["zone"]="direct (<7A)" if p["x"]<7 else ("near-rim (7-14A)" if p["x"]<14 else "outside (>=14A)")
    fig,axes=plt.subplots(1,2,figsize=(12.5,5),gridspec_kw={"width_ratios":[1.25,1]})
    ax=axes[0]
    for z,cc in [("direct (<7A)","#e6550d"),("near-rim (7-14A)","#fdae6b"),("outside (>=14A)","#c6dbef")]:
        sub=[p for p in pts if p["zone"]==z]
        if sub:
            ax.scatter([p["x"] for p in sub],[p["y"] for p in sub],s=46,
                       color=["#8c2d04" if p["diff"] else "#dfe7ef" for p in sub],edgecolor="k",lw=.4,zorder=3)
    for p in pts:
        if p["x"]<14: ax.annotate(p["lab"],(p["x"],p["y"]),xytext=(3,2),textcoords="offset points",fontsize=6.8)
    ax.axvspan(0,7,color="#fde0dd",zorder=0); ax.axvspan(7,14,color="#fff7e6",zorder=0)
    ax.set_xlabel("closest distance of variable-residue side chain to bound ligand 4KT (A)")
    ax.set_ylabel("physicochemical difference, TNIK vs MAP4K4")
    ax.set_title("Reachability of the 31 sequence-variable residues vs the 100%-conserved contact shell\n"
                 "Within 7 A of the ligand there is NO exploitable difference (only L30V edge, 5.6 A, Delta~0.13)",
                 fontsize=8.2)
    ax.legend(handles=[plt.Line2D([0],[0],marker='o',color='none',mfc="#8c2d04",mec='k',label='differs vs MAP4K4'),
                       plt.Line2D([0],[0],marker='o',color='none',mfc="#dfe7ef",mec='k',label='identical vs MAP4K4')],
              fontsize=7,frameon=False); ax.set_xlim(0,40)
    def cap(tn,m4):
        if set([tn,m4])<=set("VILAM"): return .30
        if set([tn,m4])<=set("TA") or set([tn,m4])<=set("STAGCN"): return .40
        if set([tn,m4])<=set("DE"): return .50
        if {tn,m4}=={"Q","L"}: return .60
        if tn in "WYF" or m4 in "WYF": return .80
        return .40
    items=[]
    for r in REACH.values():
        if r["min"] is None or r["min"]>15 or r["tn"]==r["m4"]: continue
        items.append((0,r["tn"],r["m4"],r["min"],cap(r["tn"],r["m4"])))
    # sort by up using REACH order
    items=[]
    for up,r in REACH.items():
        if r["min"] is None or r["min"]>15 or r["tn"]==r["m4"]: continue
        items.append((int(up),r["tn"],r["m4"],r["min"],cap(r["tn"],r["m4"])))
    items.sort(key=lambda z:z[3])
    ax2=axes[1]
    labels=[f"{a}{b}@{u}\n({dd:.1f}A)" for u,a,b,dd,c in items]
    vals=[c for *_,c in items]
    ax2.bar(range(len(vals)),vals,color="#31a354",width=.5,edgecolor="k",lw=.4)
    ax2.axhline(4.13,color="#d7301f",ls="--",lw=1.3)
    ax2.text(len(vals)-0.4,4.3,"4.13 kcal/mol  ==  1000x selectivity",color="#d7301f",fontsize=7.2,ha="right")
    total=sum(vals); mx=math.exp(total/0.593) if total else 1
    ax2.text(0.02,0.88,f"sum of optimistic ceilings (TNIK vs MAP4K4, reach <=15 A)\n= {total:.1f} kcal/mol -> <= {mx:.0f}x (upper bound)\n"
             "Even the claimed 1000x (=4.13 kcal) is unreachable from these contacts",transform=ax2.transAxes,
             fontsize=7.6,bbox=dict(fc="#ffffe0",ec="#999999",lw=.5))
    ax2.set_xticks(range(len(vals))); ax2.set_xticklabels(labels,fontsize=6.4)
    ax2.set_ylabel("optimistic per-contact dG ceiling (kcal/mol)"); ax2.set_ylim(0,5.2)
    ax2.set_title("Selectivity budget from reachable TNIK<->MAP4K4 variable residues - upper bound ~12x, not 1000x",
                  fontsize=8.2)
    plt.tight_layout(); plt.savefig(path,dpi=180); plt.close(fig)

# ============================ rotamer / subtype-vector / loss ============================
def rotamer_report():
    lines=["CONSERVED ATP-CONTACT SHELL (5AX9.4KT, <=4.5 A) - all 20/20 identical across TNIK/MAP4K4/MINK1:",
           "  UniProt  res  chi-dof"]
    tot=0
    for up in sorted(SHELL45):
        dom=up-24; aa=SEQUENCES["TNIK"][dom-1]; tot+=CHI[aa]
        lines.append(f"   {up:>5}   {aa:>3}    {CHI[aa]}")
    lines.append(f"  total rotatable side-chain dihedral DOF frozen into ONE crystal rotamer each: {tot}")
    return lines, tot

def subtype_vectors():
    """Real-coordinate guidance vectors: hinge H-bond centroid -> side-chain centroid of each
    TNIK-vs-MAP4K4 variable residue observed in 5AX9.  Returns dict up->(unit vector, reach A)."""
    import math as _m
    an=np.array(POCKET["__hinge_hbond__"])
    out={}
    for up in ["30","68","113","117","129","134"]:
        g=POCKET.get(up)
        if not g or not g.get("sc"): continue
        v=np.array(g["sc"])-an; L=float(_m.sqrt((v*v).sum()))
        if L<1e-6: continue
        out[up]=[ (v/L).tolist(), round(L,1), g["aa"] ]
    return an.tolist(), out

def subtype_discrimination_score(axis):
    """Sum over TNIK-vs-MAP4K4 variable residues within the cone of a proposed growth axis,
    weighted by physchem difference (>=0). Demonstrates the subtype term of the loss."""
    import numpy as np
    an,vecs=subtype_vectors()
    ax=np.array(axis)/np.linalg.norm(axis)
    S=0.0; details=[]
    for up,(u,L,aa) in vecs.items():
        upi=int(up); dom=upi-24
        r=REACH[up]
        if r["tn"]==r["m4"]: w=0.0
        else: w=physdist(r["tn"],r["m4"])
        c=float(np.dot(ax,np.array(u)))
        if c>0:
            S+=w*c; details.append((upi,aa,round(c,2),round(L,1),round(w,3)))
    return S, sorted(details)

# ============================ main ============================
def main():
    show_figs = "--no-figures" not in sys.argv
    print("="*100)
    print("TNIK / MAP4K4 / MINK1 (STE20, GCK-IV) de novo generative selectivity audit")
    print("="*100)
    print("Data: UniProt kinase domains 25-289 (TNIK Q9UKE5, MAP4K4 O95819, MINK1 Q8N4C8);")
    print("      5AX9 (TNIK + 4KT, 2.4 A) and 2X7F (TNIK + 824, 2.8 A) - both verified human TNIK.")
    seqs=[SEQUENCES[k] for k in ("TNIK","MAP4K4","MINK1")]
    idents=[("TNIK-MAP4K4",seqs[0],seqs[1]),("TNIK-MINK1",seqs[0],seqs[2]),("MAP4K4-MINK1",seqs[1],seqs[2])]
    for name,a,b in idents:
        n=sum(1 for x,y in zip(a,b) if x!=y)
        print(f"  kinase-domain identity {name}: {100*(len(a)-n)/len(a):.2f}%  ({n}/{len(a)} substitutions)")
    vp=variable_positions()
    print(f"  variable positions in 265-aa kinase domain: {len(vp)}")
    print(f"  ATP-contact shell <=4.5 A: {len(SHELL45)} residues, ALL conserved across the 3 paralogs "
          f"(incl. gatekeeper M105, hinge Cys108 H-bonds, back pocket).")
    print(f"  ATP-contact shell <=6.0 A: {len(SHELL60)} residues; variable within 6 A: "
          f"{sum(1 for u in SHELL60 if str(u) in REACH and REACH[str(u)]['min']<=6.0)}")
    near=sorted([(u,REACH[str(u)]["min"]) for u in REACH if REACH[str(u)]["min"] is not None],key=lambda z:z[1])
    print("  nearest variable residues to bound ligand (A):", ", ".join(f"U{u}:{d:.1f}" for u,d in near[:4]))
    need=0.593*math.log(1000)
    print(f"  DeltaDeltaG for 1000x selectivity = RT*ln(1000) = {need:.2f} kcal/mol (RT=0.593)")
    gap=12.8-8.2
    print(f"  claimed docking-score gap TNIK vs MAP4K4 = {gap:.1f} kcal/mol == EXCEEDS the 1000x threshold "
          f"but equals ~docking-score noise on different static crystal conformers; it is NOT a binding free-energy difference.")

    lines,tot=rotamer_report()
    print("\n"+ "\n".join(lines))

    an,vecs=subtype_vectors()
    print("\nSubtype guidance vectors (real 5AX9 geometry; hinge H-bond centroid -> variable residue side chain):")
    for up,(u,L,aa) in sorted(vecs.items(),key=lambda z:z[1][1]):
        print(f"   U{up} ({aa})  reach {L:5.1f} A   unit {tuple(round(x,2) for x in u)}")

    # compare proposed growth axes for subtype discrimination
    import numpy as np
    def unit(a): return (np.array(a)/np.linalg.norm(a)).tolist()
    hinge=np.array(POCKET["__hinge_hbond__"])
    # axis1 = 'back pocket' Lead-01 direction (to conserved gatekeeper M105 side chain) -> no subtype info
    sc105=POCKET["105"]["sc"]; ax_back=unit(np.array(sc105)-hinge)
    # axis2 = 4KT real distal-arm axis (empirically promiscuous)
    ax_4kt=unit(np.array(POCKET["__4kt_arm_centroid__"])-hinge)
    # axis3 = toward nearest variable rim residue U113 (V->I in MAP4K4)
    sc113=POCKET["113"]["sc"]; ax_rim113=unit(np.array(sc113)-hinge)
    # axis4 = toward farther rim residue U68 (Q->L in MAP4K4)
    sc68=POCKET["68"]["sc"]; ax_rim68=unit(np.array(sc68)-hinge)
    print("\nSubtype-discrimination score of proposed molecular growth axes "
          "(sum over variable residues of w*cos; higher = more isoform information):")
    for name,axis in [("Lead-01-style back-pocket axis (M105)",ax_back),
                      ("4KT authentic distal-arm axis",ax_4kt),
                      ("rim axis toward V113/I113",ax_rim113),
                      ("rim axis toward Q68/L68",ax_rim68)]:
        S,det=subtype_discrimination_score(axis)
        print(f"   {name:38s}  S_subtype = {S:+.3f}   {det}")
    print("\nLoss re-formulation (geometric vector guidance):")
    print(r"""  Original generative objective (affinity-centric):
    L = w_dock * E_dock(x|pose; PDB)  +  w_SA * SAScore(x)  +  w_ph * ph(x)
  Re-engineered objective (subtype-discriminating):
    L' = L
       + lam_sub * sum_p w_p * max(0,  (r_p(x) - d0_p))          # reward growing INTO a genuinely
             ... over P = {reachable non-conserved rim residues}    # non-conserved sub-space (vector g_p)
       - lam_cons * contacts_buried_in_conserved_shell(x)          # penalise extra affinity-only packing
       - lam_rot * rotamer_ensemble_clash(x)                        # score vs P-loop/aC ensemble, not one snapshot
  where r_p(x) = projection of the newly grown vector onto g_p = (SC_p - hinge_anchor)/|..|
  (g_p computed from the reference TNIK co-crystal, see table above).
  Guidance toward V113/I113 or Q68/L68 (genuine TNIK vs MAP4K4 differences) is the only
  information-carrying direction; guidance toward the conserved shell encodes promiscuity.""")
    print("\nAUDIT VERDICT")
    print(f"  (1) ATP-site contact network is sequence-identical across the three GCK-IV paralogs;")
    print(f"      a hinge double-H-bond (Cys108 backbone) + back-pocket aryl therefore binds all three equally.")
    # optimistic selectivity-budget total from fig4 panel (b), recomputed here
    def _cap(tn,m4):
        if set([tn,m4])<=set("VILAM"): return .30
        if set([tn,m4])<=set("TA") or set([tn,m4])<=set("STAGCN"): return .40
        if set([tn,m4])<=set("DE"): return .50
        if {tn,m4}=={"Q","L"}: return .60
        if tn in "WYF" or m4 in "WYF": return .80
        return .40
    _budget=sum(_cap(r["tn"],r["m4"]) for r in REACH.values()
                if r["min"] is not None and r["min"]<=15 and r["tn"]!=r["m4"])
    print(f"  (2) The claimed 1000x requires {need:.2f} kcal/mol, but the OPTIMISTIC upper bound summed over")
    print(f"      every reachable (<=15 A) TNIK-vs-MAP4K4 variable residue is only {_budget:.2f} kcal/mol")
    print(f"      (<= {math.exp(_budget/0.593):.0f}x; figure 4); real exploitable differences are even smaller.")
    print(f"  (3) The docking-score gap (-12.8 vs -8.2) is a static-snapshot artifact: the P-loop moves ~1.97 A RMSD")
    print(f"      (max 5.3 A) between two TNIK co-crystals while the hinge moves only 0.85 A - 'P-loop induced collapse'.")
    print(f"  (4) True GCK-IV-selective chemotypes must engage non-conserved peripheral/allosteric space (vector loss above);")
    print(f"      none was demonstrated by the model under review -> >1000x 'absolute subtype selectivity' is not credible.")
    if show_figs:
        fig1(); fig2(); fig3(); fig4()
        print("\nFigures written: fig1_microenv_diff_matrix.png, fig2_ploop_static_bias.png,")
        print("                 fig3_molecule_comparison.png, fig4_subtype_budget.png")

if __name__=="__main__":
    main()
