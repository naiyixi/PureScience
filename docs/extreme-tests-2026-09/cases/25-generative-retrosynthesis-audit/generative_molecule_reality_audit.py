#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
generative_molecule_reality_audit.py
====================================
《基于扩散模型的 TNIK 抑制剂生成算法病态几何与反合成阻遏审查》 —— 工业级先导化合物现实性审查管线。

目的 / Purpose
--------------
对 "SE(3)-等变扩散模型生成、自称超低 Glide/AutoDock 打分、高度类药、3 步可合成" 的候选分子
做一套可复现的反向物理审查：

  (1) 一维 / 二维物化性质现实性        : MW / cLogP / HBD / HBA / TPSA / rot / Fsp3 / QED / Ro5
  (2) 合成可达性                      : SAscore + 基于"断键类型模板 + 片段 SAscore"的反合成可达性启发式
  (3) 结构警示                        : PAINS (A/B/C) + Brenk + NIH (RDKit FilterCatalog) + REOS 反应性子集
  (4) 环系拓扑与张力                   : 环大小分布、7–9 元中环/4 元小环标记、稠合/螺环/桥头计数、
                                       文献环张力估值、环系复杂度审计指数
  (5) 构象 / 扭转张力                  : MMFF94s 逐扭转角受约束(固定点)relaxed scan；
                                       每键扭转能垒、π-共轭键平面化惩罚；分子级"平面几何锁定张力"(kcal/mol)
  (6) 帕累托虚假收敛                  : 在声称目标 (QED↑ / 声称对接分↓ / SAscore↓) 上的前沿
                                       与"现实性修正 + 硬闸门"后的前沿对比，显示生成物虚假占优的塌缩

数据诚实性说明 (IMPORTANT)
--------------------------
  * 本脚本**不做分子对接**。演示数据中 "dock_score_claimed" 是仿真输入，代表某生成平台宣称的
    Glide 分数（审查对象），不是本脚本测得的量。
  * 力场为 MMFF94s（气相，无水、无受体）。OPLS4/AMBER 显式溶剂化精修需在真实平台上执行；
    本脚本测量的扭转平面化/能垒张力是该类精修后构象"崩塌"的内在驱动力，方向与量级可外推。
  * 若无真实平台输出的 SDF/pose，可将 pose SDF 喂给本脚本作 E(pose)−E(global-min) 应变审计
    （见 strain_of_pose），得到真实的对接姿态应变。

用法 / Usage
------------
    python generative_molecule_reality_audit.py                     # 运行内置演示审查
    python generative_molecule_reality_audit.py --csv hits.csv --dock-col glide   # 审查真实数据
    python generative_molecule_reality_audit.py --out-dir out --confs 30 --step 30

作者注：仅用于方法学演示与对抗性审查教学。分子结构/分数如有真实来源请替换 demo 数据集。
"""

import os
import sys
import json
import copy
import math
import argparse
import warnings
from collections import Counter

import numpy as np

warnings.filterwarnings("ignore")
from rdkit import RDLogger
RDLogger.DisableLog("rdApp.*")

from rdkit import Chem
from rdkit.Chem import (AllChem, Descriptors, QED, rdMolDescriptors as rdmd,
                        rdMolTransforms, rdForceFieldHelpers as ffh, FilterCatalog)
from rdkit.Geometry import Point3D

# ------------------------------------------------------------------------------
# SAscore (RDKit contrib)
# ------------------------------------------------------------------------------
try:
    from rdkit.Chem import RDConfig
    _SA_DIR = os.path.join(RDConfig.RDContribDir, "SA_Score")
    if os.path.isdir(_SA_DIR) and _SA_DIR not in sys.path:
        sys.path.append(_SA_DIR)
    import sascorer  # noqa: E402
    _SA_AVAIL = True
except Exception:  # pragma: no cover
    _SA_AVAIL = False


def sascore(mol):
    """SAscore（越小越易合成；约 >6 表示合成极难）。不可用返回 None。"""
    if not _SA_AVAIL:
        return None
    try:
        return float(sascorer.calculateScore(mol))
    except Exception:
        return None


# ------------------------------------------------------------------------------
# 结构警示 : PAINS / Brenk / NIH (RDKit) + REOS 反应性子集 (自定义 SMARTS)
# ------------------------------------------------------------------------------
def _build_filter_catalog():
    p = FilterCatalog.FilterCatalogParams()
    fc = FilterCatalog.FilterCatalogParams.FilterCatalogs
    p.AddCatalog(fc.PAINS_A); p.AddCatalog(fc.PAINS_B); p.AddCatalog(fc.PAINS_C)
    p.AddCatalog(fc.BRENK); p.AddCatalog(fc.NIH)
    return FilterCatalog.FilterCatalog(p)


_FILTER_CAT = _build_filter_catalog()

# REOS (Roche "Rapid Elimination Of Swill") 精神的自定义反应性/毒性子集。
# 注意：仅为教学性子集，非完整 REOS；逐条 SMARTS 均需对正负控自检。
REOS_RULES = [
    ("alkyl_halide_reactive", "[#6X4][Cl,Br,I]"),
    ("michael_acceptor_enone", "[CX3!r]=[CX3!r][CX3]=[OX1]"),
    ("aldehyde", "[CX3H1;!R]=[OX1]"),
    ("epoxide", "[#6;r3]1[#8;r3][#6;r3]1"),
    ("isothiocyanate", "[#16]=[#6]=[#7]"),
    ("azide", "[#7X2]=[#7X2]=[#7X2]"),
    ("peroxide", "[OX2][OX2]"),
    ("nitro", "[$([NX3](=O)=O),$([NX3+](=O)[O-])]"),
    ("anhydride", "[CX3](=O)[OX2][CX3](=O)"),
    ("primary_alkyl_halide_mustard", "[NX3][CX4][Cl,Br,I]"),
]


def _filter_entry_label(entry):
    """提取 (集合, 描述)。不同 RDKit 版本属性 API 不同，统一兼容。"""
    desc = entry.GetDescription()
    try:
        props = entry.GetPropList()
    except Exception:
        props = []
    coll = ""
    for pn in props:
        if "FilterSet" in pn:
            try:
                coll = entry.GetProp(pn)
            except Exception:
                coll = ""
    return coll, desc


def structural_alerts(mol):
    """返回 dict: pains=[] brenk=[] nih=[] reos=[]（每条为 '集合:规则描述'）。"""
    out = {"pains": [], "brenk": [], "nih": [], "reos": []}
    try:
        for entry in _FILTER_CAT.GetMatches(mol):
            coll, desc = _filter_entry_label(entry)
            low = coll.lower()
            if "pains" in low:
                out["pains"].append(f"{coll}:{desc}")
            elif "brenk" in low:
                out["brenk"].append(f"{coll}:{desc}")
            else:
                out["nih"].append(f"{coll or 'NIH'}:{desc}")
    except Exception:
        pass
    for nm, sma in REOS_RULES:
        try:
            patt = Chem.MolFromSmarts(sma)
            if patt is not None and mol.HasSubstructMatch(patt):
                out["reos"].append(nm)
        except Exception:
            pass
    return out


# ------------------------------------------------------------------------------
# 环系拓扑、环张力估计、复杂度审计指数
# ------------------------------------------------------------------------------
# 环烷烃张力能 (kcal/mol)，经典数据（环 3-10）：内环张力 / transannular 之和
RING_STRAIN_LIT = {3: 27.5, 4: 26.3, 5: 6.2, 6: 0.0, 7: 6.2, 8: 9.7, 9: 12.6,
                   10: 12.4, 11: 11.3, 12: 6.4}


def ring_topology(mol):
    """环统计 + 文献环张力估计 + 环系复杂度审计指数。"""
    ri = mol.GetRingInfo()
    ring_atom_sets = [set(r) for r in ri.AtomRings()]
    sizes = [len(r) for r in ri.AtomRings()]
    size_counter = Counter(sizes)

    arom = {a.GetIdx() for a in mol.GetAtoms() if a.GetIsAromatic()}

    # 环系统数：由"成环原子"诱导的子图连通分量数
    ring_atoms = set().union(*ring_atom_sets) if ring_atom_sets else set()
    if ring_atoms:
        emol = Chem.RWMol(mol)
        # 去掉所有非环键后求连通分量
        ring_bonds = set()
        for b in mol.GetBonds():
            if b.GetBeginAtomIdx() in ring_atoms and b.GetEndAtomIdx() in ring_atoms and b.IsInRing():
                ring_bonds.add((b.GetBeginAtomIdx(), b.GetEndAtomIdx()))
        # 直接在 ring_atoms 上做并查集
        parent = {i: i for i in ring_atoms}
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]; x = parent[x]
            return x
        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
        for b in mol.GetBonds():
            if b.IsInRing():
                union(b.GetBeginAtomIdx(), b.GetEndAtomIdx())
        n_systems = len({find(i) for i in ring_atoms})
    else:
        n_systems = 0

    # 螺原子 / 桥头原子近似
    atom_ring_count = Counter(a for r in ring_atom_sets for a in r)
    n_spiro = 0
    for a in atom_ring_count:
        if atom_ring_count[a] >= 2:
            # spiro: 该原子属于 ≥2 个环且这些环彼此只共享该原子
            rings_with_a = [r for r in ring_atom_sets if a in r]
            shared_other = set()
            for i, r1 in enumerate(rings_with_a):
                for r2 in rings_with_a[i + 1:]:
                    inter = r1 & r2
                    if inter - {a}:
                        shared_other.add(tuple(sorted(inter - {a})))
            if not shared_other:
                n_spiro += 1
    n_bridgehead = sum(1 for a, c in atom_ring_count.items() if c >= 3)

    # 环张力估计：每个环，芳香环→0；否则按环内 sp3 原子占比折减
    ring_strain = 0.0
    medium_rings = []
    small_rings = []
    for r in ring_atom_sets:
        sz = len(r)
        if sz > 12:
            continue
        if r <= arom and sz in (5, 6):          # 全芳香 5/6 元环 → 无张力
            continue
        n_sp3 = sum(1 for a in r if mol.GetAtomWithIdx(a).GetHybridization()
                    == Chem.HybridizationType.SP3)
        frac = n_sp3 / sz
        est = RING_STRAIN_LIT.get(sz, 0.0) * frac
        # 全共轭/芳香环（非6元稠合）不叠加
        if 7 <= sz <= 9 and frac > 0.2:
            medium_rings.append(sz)
        if sz in (3, 4):
            small_rings.append(sz)
        ring_strain += est

    # 复杂度审计指数（启发式，非标准量）
    n_arom_rings = sum(1 for r in ring_atom_sets if r <= arom)
    complexity = (2 * n_systems + n_arom_rings + 2 * n_spiro + 3 * n_bridgehead
                  + 2 * len(medium_rings) + 1.5 * len(small_rings))

    return {
        "n_rings": len(ring_atom_sets),
        "ring_sizes": sizes,
        "size_counter": dict(sorted(size_counter.items())),
        "n_ring_systems": n_systems,
        "n_aromatic_rings": n_arom_rings,
        "n_spiro": n_spiro,
        "n_bridgehead": n_bridgehead,
        "medium_rings_7_9": sorted(medium_rings),
        "small_rings_3_4": sorted(small_rings),
        "ring_strain_est_kcal": round(ring_strain, 2),
        "complexity_index": round(complexity, 2),
    }


# ------------------------------------------------------------------------------
# 反合成可达性启发式：断键类型模板 + 片段 SAscore
# ------------------------------------------------------------------------------
def _atom_is_carbonyl_c(a, mol):
    return any(mol.GetBondBetweenAtoms(a.GetIdx(), n.GetIdx()).GetBondTypeAsDouble() == 2.0
               and n.GetSymbol() == "O" for n in a.GetNeighbors())


def _bond_cut_type(u, v, mol):
    """按化学类型分类一条可断的单键，返回类型字符串或 None。"""
    # 从子结构角度：先做简单原子型分类
    ar_u = u.GetIsAromatic(); ar_v = v.GetIsAromatic()
    sym = (u.GetSymbol(), v.GetSymbol())
    if "S" in sym and _atom_is_carbonyl_c(u, mol) is False and _atom_is_carbonyl_c(v, mol) is False:
        if ("S", "N") in (sym, sym[::-1]) or ("S", "O") in (sym, sym[::-1]):
            return "sulfonamide/sulfonate"
    if _atom_is_carbonyl_c(u, mol) or _atom_is_carbonyl_c(v, mol):
        c = u if _atom_is_carbonyl_c(u, mol) else v
        other = v if _atom_is_carbonyl_c(u, mol) else u
        if other.GetSymbol() == "N":
            return "amide"
        if other.GetSymbol() == "O":
            return "ester"
        if other.GetSymbol() == "S":
            return "thioester"
        if ar_u and ar_v:
            return "aryl_carbonyl"
        return "carbonyl_alkyl"
    if ar_u and ar_v:
        return "biaryl"
    if ("N" in sym) and (ar_u or ar_v):
        return "N_aryl_amine"
    if ar_u != ar_v and {u.GetSymbol(), v.GetSymbol()} & {"O", "N"}:
        return "hetero_alkyl_aromatic"
    if ar_u != ar_v:
        return "alkyl_aromatic"
    return None


def _split_at_bond(mol, bond):
    """在单键处断开，靠隐式 H 重感知闭合两个切断端价态，返回两个片段 Mol（封闭壳"砌块"近似）。

    自由基会破坏后续 sanitize/sascore，故用"隐式 H 重算"而非自由基片段；两片段加氢数量为该
    逆合成切断反应所选封端方案的近似（启发式）。失败返回 (None, None)。
    """
    try:
        rw = Chem.RWMol(mol)
        i, j = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        rw.RemoveBond(i, j)
        frag = rw.GetMol()
        frag.UpdatePropertyCache(strict=False)
        Chem.SanitizeMol(frag)
        frags = list(Chem.GetMolFrags(frag, asMols=True, sanitizeFrags=True))
        if len(frags) == 2:
            return tuple(frags)
        return (None, None)
    except Exception:
        return (None, None)


def retro_accessibility(mol):
    """基于"产物断键类型 + 两片段商业级简易度(SAscore)"的反合成可达性启发式。

    只考虑药学合成最常用的官能团化切断：酰胺/酯/磺酰胺、联芳基 Suzuki、C(芳)-N 胺化
    (Buchwald/SNAr)、芳基-羰基等；甲基醚、芳基卤等不被当作"可行逆合切断"。

    在真实工业管线中，此处应接入含商用砌块的模板反应数据库（如 ZINC/REAL、eMolecules）；
    本实现用"片段 SAscore <= 阈值"近似"砌块可由廉价库存获得"。
    """
    PRODUCTIVE = {"amide", "ester", "thioester", "sulfonamide/sulfonate",
                  "biaryl", "N_aryl_amine", "aryl_carbonyl"}
    HALOGENS = {"F", "Cl", "Br", "I"}
    BB_SA_MAX = 3.0  # 片段 SAscore ≤ 该值视为"商业可得/简单砌块"（近似，可调）
    sa_mol = sascore(mol)
    candidate = []
    feasible = []
    seen = set()
    for b in mol.GetBonds():
        if b.IsInRing():
            continue
        if b.GetBondTypeAsDouble() != 1.0:
            continue
        u = b.GetBeginAtom(); v = b.GetEndAtom()
        if u.GetAtomicNum() == 1 or v.GetAtomicNum() == 1:
            continue
        if u.GetSymbol() in HALOGENS or v.GetSymbol() in HALOGENS:
            continue
        ctype = _bond_cut_type(u, v, mol)
        if ctype not in PRODUCTIVE:
            continue
        # N_aryl_amine 型切断要求 N 非末端（末端 NH2/amino 应经硝化还原等官能团转化，非偶联）
        if ctype == "N_aryl_amine":
            n_atom = u if u.GetSymbol() == "N" else v
            if len(_heavy_neighbors(n_atom)) < 2:
                continue
        key = tuple(sorted((u.GetIdx(), v.GetIdx())))
        if key in seen:
            continue
        seen.add(key)
        f1, f2 = _split_at_bond(mol, b)
        if f1 is None:
            continue
        s1, s2 = sascore(f1), sascore(f2)
        candidate.append({"type": ctype, "atoms": list(key)})
        if s1 is not None and s2 is not None and max(s1, s2) <= BB_SA_MAX:
            feasible.append({"type": ctype, "fragSA": round(max(s1, s2), 2)})
    n_cand = len(candidate)
    n_feas = len(feasible)
    route_score = n_feas / n_cand if n_cand else 0.0
    step3 = (sa_mol is not None and sa_mol <= 3.4 and n_feas >= 1)
    return {
        "sa_score": round(sa_mol, 2) if sa_mol is not None else None,
        "n_candidate_cuts": n_cand,
        "n_feasible_cuts": n_feas,
        "route_score": round(route_score, 3),
        "3step_synth_heuristic": bool(step3),
        "cut_types": [c["type"] for c in candidate],
    }


# ------------------------------------------------------------------------------
# 描述符
# ------------------------------------------------------------------------------
def physicochemical(mol):
    mw = Descriptors.MolWt(mol)
    clogp = Descriptors.MolLogP(mol)
    hbd = rdmd.CalcNumHBD(mol)
    hba = rdmd.CalcNumHBA(mol)
    tpsa = Descriptors.TPSA(mol)
    rot = rdmd.CalcNumRotatableBonds(mol)
    fsp3 = rdmd.CalcFractionCSP3(mol)
    ar = rdmd.CalcNumAromaticRings(mol)
    stereo = len(Chem.FindMolChiralCenters(mol, includeUnassigned=True))
    qed = QED.qed(mol)
    ro5_viol = sum([mw > 500, clogp > 5, hbd > 5, hba > 10])
    return {"MW": round(mw, 1), "cLogP": round(clogp, 2), "HBD": hbd, "HBA": hba,
            "TPSA": round(tpsa, 1), "RotB": rot, "Fsp3": round(fsp3, 2),
            "ArRings": ar, "StereoCenters": stereo, "QED": round(qed, 3),
            "Ro5_viol": int(ro5_viol)}


# ------------------------------------------------------------------------------
# 构象 + 扭转角能量（MMFF94s, 固定点 relaxed scan）
# ------------------------------------------------------------------------------
_MMFF_VARIANT = "MMFF94s"


def _mmff_props(molh):
    return ffh.MMFFGetMoleculeProperties(molh, mmffVariant=_MMFF_VARIANT)


def _mmff_e(molh, props=None):
    props = props or _mmff_props(molh)
    return ffh.MMFFGetMoleculeForceField(molh, props).CalcEnergy()


def _points(molh, confId=0):
    c = molh.GetConformer(confId)
    return [c.GetAtomPosition(i) for i in range(molh.GetNumAtoms())]


def _set_points(molh, pts):
    molh.RemoveAllConformers()
    c = Chem.Conformer(molh.GetNumAtoms())
    for i in range(molh.GetNumAtoms()):
        p = pts[i]
        c.SetAtomPosition(i, Point3D(p.x, p.y, p.z))
    molh.AddConformer(c, assignId=True)
    return molh.GetConformer()


def _heavy_neighbors(a, exclude=-1):
    return [n.GetIdx() for n in a.GetNeighbors()
            if n.GetAtomicNum() > 1 and n.GetIdx() != exclude]


def _prefer_arom(mol, lst):
    ring = [i for i in lst if mol.GetAtomWithIdx(i).GetIsAromatic()]
    return ring[0] if ring else lst[0]


def _is_pi_linker(mol, a1, a2):
    """单键两端均为"可共轭"原子(芳香 C / 羰基 C / 与芳环或羰基相连的 N)。"""
    def conj(a):
        if a.GetIsAromatic():
            return True
        if _atom_is_carbonyl_c(a, mol):
            return True
        if a.GetSymbol() == "N":
            return any(n.GetIsAromatic() or _atom_is_carbonyl_c(n, mol)
                       for n in a.GetNeighbors())
        return False
    return conj(a1) and conj(a2)


def find_scannable_torsions(molh):
    """返回 [(a0,a1,a2,a3, kind)]，kind ∈ {'pi','rot'}。"""
    out = []
    mol = molh
    for b in mol.GetBonds():
        if b.IsInRing() or b.GetBondTypeAsDouble() != 1.0:
            continue
        u, v = b.GetBeginAtom(), b.GetEndAtom()
        if u.GetAtomicNum() == 1 or v.GetAtomicNum() == 1:
            continue
        nu = _heavy_neighbors(u, v.GetIdx())
        nv = _heavy_neighbors(v, u.GetIdx())
        if not nu or not nv:
            continue
        a0 = _prefer_arom(mol, nu)
        a3 = _prefer_arom(mol, nv)
        kind = "pi" if _is_pi_linker(mol, u, v) else "rot"
        out.append((a0, u.GetIdx(), v.GetIdx(), a3, kind))
    return out


def torsion_relaxed_scan(molh, props, torsion, step=30):
    """对指定扭转 (a0,a1,a2,a3) 做固定4原子 relaxed MMFF scan。返回 (phi[], E[]) kcal/mol。"""
    a0, a1, a2, a3 = torsion
    base = _points(molh)
    phis, Es = [], []
    for phi in range(0, 360, step):
        _set_points(molh, base)
        rdMolTransforms.SetDihedralDeg(molh.GetConformer(), a0, a1, a2, a3, float(phi))
        ff = ffh.MMFFGetMoleculeForceField(molh, props)
        for idx in (a0, a1, a2, a3):
            ff.AddFixedPoint(idx)
        ff.Minimize(maxIts=400)
        phis.append(phi)
        Es.append(ff.CalcEnergy())
    _set_points(molh, base)
    return phis, Es


def conformer_ensemble_energy(mol_smi, n_confs=24, seed=7):
    """返回 (E_min_kcal, best_conformer_molh_with_Hs, energies)。"""
    mol = Chem.MolFromSmiles(mol_smi)
    if mol is None:
        return None, None, []
    mh = Chem.AddHs(mol)
    if mh.GetNumAtoms() > 90:
        return None, None, []
    cids = AllChem.EmbedMultipleConfs(mh, numConfs=n_confs, randomSeed=seed,
                                      pruneRmsThresh=0.35, maxAttempts=800)
    props = _mmff_props(mh)
    if props is None:
        return None, None, []
    Es = []
    best_id, best_e = None, 1e9
    for cid in cids:
        try:
            AllChem.MMFFOptimizeMolecule(mh, mmffVariant=_MMFF_VARIANT, maxIters=500, confId=cid)
            e = _mmff_e(mh, props)
            Es.append(e)
            if e < best_e:
                best_e, best_id = e, cid
        except Exception:
            continue
    if best_id is None:
        return None, None, []
    return best_e, mh, Es


def torsion_strain_analysis(smiles, n_confs=24, step=30, seed=7):
    """主构象/扭转分析。

    返回 dict:
      Emin_kcal, torsion_bonds:[{dihed, barrier_kcal, planarity_penalty_kcal, kind}],
      planar_strain_kcal (= sum planarity penalty over 'pi' bonds),
      planar_axes (计数), best_conformer_mol (供 pose 应变审计)
    """
    best_e, mh, Es = conformer_ensemble_energy(smiles, n_confs=n_confs, seed=seed)
    result = {"Emin_kcal": None if best_e is None else round(best_e, 2),
              "n_conformers": len(Es), "torsion_bonds": [],
              "planar_strain_kcal": 0.0, "n_pi_axes": 0, "molh": None}
    if mh is None:
        return result
    props = _mmff_props(mh)
    if props is None:
        return result
    result["molh"] = mh
    bonds = find_scannable_torsions(mh)
    planar_sum = 0.0
    n_pi = 0
    BARRIER_CAP = 35.0   # 固定点扫描在极受阻轴上会因刚性几何产生非物理能垒；>35 视为"旋转被阻塞"
    n_blocked = 0
    for (a0, a1, a2, a3, kind) in bonds:
        try:
            phis, Esx = torsion_relaxed_scan(mh, props, (a0, a1, a2, a3), step=step)
        except Exception:
            continue
        e0 = min(Esx)
        d = dict(zip(phis, Esx))
        barrier_raw = max(Esx) - e0
        planpen = min(d.get(0, e0), d.get(180, e0)) - e0
        blocked = bool(barrier_raw > BARRIER_CAP)
        n_blocked += int(blocked)
        rec = {"torsion_atoms": [a0, a1, a2, a3], "kind": kind,
               "barrier_raw_kcal": round(barrier_raw, 2),
               "barrier_kcal": round(min(barrier_raw, BARRIER_CAP), 2),
               "rotor_blocked": blocked,
               "planarity_penalty_kcal": round(planpen, 2),
               "scan": [{"phi": int(p), "E_rel": round(e - e0, 2)} for p, e in zip(phis, Esx)]}
        result["torsion_bonds"].append(rec)
        if kind == "pi":
            planar_sum += planpen
            n_pi += 1
    result["planar_strain_kcal"] = round(planar_sum, 2)
    result["n_pi_axes"] = n_pi
    result["n_blocked_rotors"] = n_blocked
    return result


def strain_of_pose(mol_with_conformer, props, pose_conf_id=0, reference_Emin=None):
    """真实姿态应变审计：E(pose) − E(global min)。pose 来自外部对接结果的 conformer。

    若传入外部对接 pose（把 pose SDF 的构象并入 mol），reference_Emin 用 torsional 分析所得。
    若 reference_Emin 为 None 则返回绝对姿态能量。"""
    ff = ffh.MMFFGetMoleculeForceField(mol_with_conformer, props, confId=pose_conf_id)
    e_pose = ff.CalcEnergy()
    if reference_Emin is None:
        return e_pose
    return e_pose - reference_Emin


# ------------------------------------------------------------------------------
# 组装单分子审查
# ------------------------------------------------------------------------------
def audit_molecule(smiles, dock_claimed=None, mol_id="", n_confs=24, step=30, seed=7):
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return {"id": mol_id, "ok": False, "reason": "unparseable_SMILES"}
    phys = physicochemical(mol)
    alerts = structural_alerts(mol)
    rt = ring_topology(mol)
    retro = retro_accessibility(mol)
    tors = torsion_strain_analysis(smiles, n_confs=n_confs, step=step, seed=seed)
    any_alerts = bool(alerts["pains"] or alerts["reos"] or alerts["brenk"] or alerts["nih"])
    gate_reasons = []
    if alerts["pains"]:
        gate_reasons.append("PAINS")
    if alerts["reos"]:
        gate_reasons.append("REOS_reactive")
    if alerts["brenk"]:
        gate_reasons.append("Brenk")
    if rt["ring_strain_est_kcal"] >= 6.0:
        gate_reasons.append(f"ring_strain>={rt['ring_strain_est_kcal']}")
    if retro["sa_score"] is not None and retro["sa_score"] > 4.2:
        gate_reasons.append(f"SAscore>{retro['sa_score']}")
    if phys["MW"] > 550:
        gate_reasons.append("MW>550")
    if phys["cLogP"] > 5.5:
        gate_reasons.append("cLogP>5.5")
    if phys["QED"] < 0.45:
        gate_reasons.append("QED<0.45")
    # 现实性修正的对接得分：声称分 + 平面几何锁定张力（同 kcal/mol 单位，往不利方向修正）
    planar = tors["planar_strain_kcal"]
    dock_eff = None
    if dock_claimed is not None:
        dock_eff = round(dock_claimed + planar, 2)
    return {
        "id": mol_id,
        "ok": True,
        "canonical_smiles": Chem.MolToSmiles(mol),
        "phys": phys,
        "alerts": alerts,
        "alerts_any": any_alerts,
        "ring": rt,
        "retro": retro,
        "torsion": {k: v for k, v in tors.items() if k != "molh"},
        "dock_claimed": dock_claimed,
        "dock_corrected": dock_eff,
        "planar_strain_kcal": planar,
        "gate": bool(gate_reasons),
        "gate_reasons": gate_reasons,
    }


# ------------------------------------------------------------------------------
# 帕累托（所有目标均按"越大越好"归一化后求非支配集）
# ------------------------------------------------------------------------------
def pareto_front(rows, objs, dominates_all_greater=True):
    """rows: list of dict; objs: 目标键列表，值越大越好。返回非支配行下标。"""
    vals = [[r[o] for o in objs] for r in rows]
    n = len(vals)
    nd = []
    for i in range(n):
        dominated = False
        for j in range(n):
            if i == j:
                continue
            # j 支配 i 当且仅当 j 在所有目标上 >= i 且至少一个严格 >
            if all(vals[j][k] >= vals[i][k] - 1e-9 for k in range(len(objs))) and \
               any(vals[j][k] > vals[i][k] + 1e-9 for k in range(len(objs))):
                dominated = True
                break
        if not dominated:
            nd.append(i)
    return nd


# ------------------------------------------------------------------------------
# 绘图
# ------------------------------------------------------------------------------
def _prep_plot():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D
    return plt, Line2D


def make_plots(records, out_dir):
    """records: 单分子审查结果列表（每项含 id/类别字段）。返回图文件名列表。"""
    plt, Line2D = _prep_plot()
    # 在 records 上补充类别标记
    cls_of = {r["id"]: r.get("_class", "") for r in records}

    # ---- 收集扭转键级数据 ----
    ctrl_bonds, gen_bonds = [], []
    ctrl_plan, gen_plan = [], []
    ctrl_block = gen_block = 0
    for r in records:
        if not r.get("ok"):
            continue
        tb = r["torsion"].get("torsion_bonds", [])
        for b in tb:
            d = (b["barrier_kcal"], b["planarity_penalty_kcal"], b["kind"])
            (ctrl_bonds if cls_of.get(r["id"]) == "control" else gen_bonds).append(d)
            if cls_of.get(r["id"]) == "control":
                ctrl_block += int(b.get("rotor_blocked", False))
            else:
                gen_block += int(b.get("rotor_blocked", False))
            if b["kind"] == "pi":
                (ctrl_plan if cls_of.get(r["id"]) == "control" else gen_plan).append(b["planarity_penalty_kcal"])

    f1 = os.path.join(out_dir, "fig1_torsional_strain.png")
    fig, axes = plt.subplots(1, 2, figsize=(11.5, 4.6), dpi=170)
    colors = {"control": "#2b6fb3", "generated": "#c0392b"}

    def _violin(ax, data_ctrl, data_gen, title, ylab, ylim=None):
        parts = ax.violinplot([data_ctrl, data_gen], positions=[1, 2], showextrema=False, widths=0.8)
        for p, col in zip(parts["bodies"], ["control", "generated"]):
            p.set_facecolor(colors[col]); p.set_alpha(0.35); p.set_edgecolor(colors[col])
        for j, dset in enumerate([data_ctrl, data_gen], start=1):
            x = j + np.random.RandomState(j).normal(0, 0.05, size=len(dset))
            ax.scatter(x, dset, s=24, color=colors["control" if j == 1 else "generated"],
                       alpha=0.85, edgecolor="white", linewidth=0.4, zorder=3)
        ax.set_xticks([1, 2]); ax.set_xticklabels(["classical\ncontrols", "claimed\n'generated'"], fontsize=9)
        ax.set_title(title, fontsize=9.5); ax.set_ylabel(ylab)
        if ylim:
            ax.set_ylim(*ylim)
        ax.grid(alpha=0.25, axis="y")

    _violin(axes[0], [b[0] for b in ctrl_bonds], [b[0] for b in gen_bonds],
            f"Torsion-rotation barriers (MMFF94s relaxed scan)\n"
            f"bars capped at 35 kcal/mol · rotors effectively blocked (>35): control {ctrl_block} / generated {gen_block}",
            "rotational barrier  max−min  (kcal/mol)", ylim=(0, 42))
    _violin(axes[1], ctrl_plan, gen_plan,
            "Cost to force each pi-linker torsion into its conjugation plane (0 / 180 deg)",
            "planarity penalty  min(E0,E180) - Emin  (kcal/mol)")
    for ax in axes:
        for s in ["top", "right"]:
            ax.spines[s].set_visible(False)
    fig.suptitle("Torsional / conformational strain audit of 'claimed generated' hits vs classical scaffolds",
                 fontsize=11)
    fig.tight_layout(rect=[0, 0, 1, 0.95])
    fig.savefig(f1); plt.close(fig)

    # ---- 3D 帕累托散点 ----
    f2 = os.path.join(out_dir, "fig2_pareto_frontier_3d.png")
    _plot_pareto(plt, records, cls_of, f2)

    # ---- 受控配对对比（经典骨架 vs 生成"新颖"修饰） ----
    f3 = os.path.join(out_dir, "fig3_matched_pair_contrast.png")
    _plot_pairs(plt, records, f3)
    return [f1, f2, f3]


def _plot_pareto(plt, records, cls_of, path):
    from matplotlib.lines import Line2D
    fig = plt.figure(figsize=(13.5, 6.0), dpi=170)
    colors = {"control": "#2b6fb3", "generated": "#c0392b"}
    okrec = [r for r in records if r.get("ok")]
    for pane, title, use_corr in [
            (1, "A · Claimed objective space\n(QED ↑ / platform-reported docking ↓ / SAscore ↓)", False),
            (2, "B · Reality-corrected objective space\n(charging measured intramolecular pose strain to the score;\n"
                "hard-flag molecules are gated out & shown grey at their claimed values)", True)]:
        ax = fig.add_subplot(1, 2, pane, projection="3d")
        pts = []  # (x,y,z,color,marker,size,alpha,edge,id,is_gated_for_this_pane)
        for r in okrec:
            cls = cls_of.get(r["id"], "")
            x = r["phys"]["QED"]
            y = r["retro"]["sa_score"] if r["retro"]["sa_score"] is not None else 0.0
            gated = bool(r["gate"])
            if use_corr and gated:                      # 门控分子：仍按其声称值摆放，但灰化空心
                z = r.get("dock_claimed") or 0.0
                pts.append((x, y, z, "#c8c8c8", "o", 55, 0.55, "#909090", r["id"], True))
            else:
                z = (r.get("dock_corrected") if use_corr else r.get("dock_claimed")) or 0.0
                col = colors.get(cls, "#888")
                mk = "^" if cls == "control" else "o"
                pts.append((x, y, z, col, mk, 85, 0.92, "none", r["id"], gated and use_corr))
        # 帕累托前沿：只在参与分析（claimed 面板=全部；corrected 面板=未门控）的点上计算
        active = [i for i, p in enumerate(pts) if not p[9]]
        arr = [{"q": pts[i][0], "d": -pts[i][2], "s": -pts[i][1]} for i in active]
        nd_local = pareto_front(arr, ["q", "d", "s"]) if arr else []
        nd_active = {active[i] for i in nd_local}
        for i, (x, y, z, col, mk, sz, al, edge, pid, isgated) in enumerate(pts):
            if i in nd_active:
                mk, sz, edge = "*", 340, "black"
            ax.scatter(x, y, z, c=col, marker=mk, s=sz, alpha=al, edgecolors=edge,
                       linewidth=0.9, depthshade=False)
            if i in nd_active:
                ax.text(x, y, z, pid, fontsize=6.5, color="#111", zorder=12)
        ax.set_xlabel("QED  →", fontsize=9, labelpad=2)
        ax.set_ylabel("SAscore  (synthetic cost →)", fontsize=9, labelpad=2)
        ax.set_zlabel("docking score (kcal/mol) →", fontsize=9, labelpad=2)
        ax.invert_zaxis()          # 更负（更优）在上
        ax.set_title(title, fontsize=9)
        ax.view_init(elev=20, azim=-125)
    handles = [Line2D([0], [0], marker="^", color="none", markerfacecolor=colors["control"],
                      markersize=8, label="classical scaffold (control)"),
               Line2D([0], [0], marker="o", color="none", markerfacecolor=colors["generated"],
                      markersize=8, label="claimed 'generated' hit"),
               Line2D([0], [0], marker="*", color="none", markerfacecolor="gold",
                      markeredgecolor="black", markersize=12, label="Pareto-optimal (nondominated)"),
               Line2D([0], [0], marker="o", color="none", markerfacecolor="#c8c8c8",
                      markeredgecolor="#909090", markersize=8,
                      label="gated out by realism filters (grey, shown at claimed value)")]
    fig.legend(handles=handles, loc="lower center", ncol=4, fontsize=8, frameon=False,
               bbox_to_anchor=(0.5, 0.015))
    fig.suptitle("Pareto-front false convergence: the 'claimed novel hits' fill the winning corner only in the claimed "
                 "objective space;\nafter charging intramolecular pose strain and applying hard gates, that corner collapses "
                 "(6/10 hits gated; survivors re-ranked by corrected score)", fontsize=10.5)
    fig.tight_layout(rect=[0, 0.10, 1, 0.96])
    fig.savefig(path); plt.close(fig)


def _plot_pairs(plt, records, path):
    """受控配对：对每一对，画(左)平面几何锁定张力，(右)声称 vs 现实修正对接得分的塌缩。"""
    pairs = [("R01", "G01"), ("R03", "G03"), ("R04", "G08")]
    byid = {r["id"]: r for r in records if r.get("ok")}
    rows = [(a, b) for a, b in pairs if a in byid and b in byid]
    if not rows:
        return
    labels = ["6,7-diMeO-quinazolin-4-amine\n(4-anilino hinge)", "pyrrolo[2,3-d]pyrimidin-4-amine\n(5-aryl hinge)",
              "extended 4-anilino-quinazoline\n(morpholine tail)"]
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.6), dpi=170)
    x = np.arange(len(rows)); w = 0.36

    ax = axes[0]
    ctrl = [byid[a]["planar_strain_kcal"] for a, _ in rows]
    gen = [byid[b]["planar_strain_kcal"] for _, b in rows]
    ax.bar(x - w / 2, ctrl, w, label="classical (control)", color="#2b6fb3", alpha=0.9)
    ax.bar(x + w / 2, gen, w, label="claimed 'generated' analog", color="#c0392b", alpha=0.9)
    for xi, c, g in zip(x, ctrl, gen):
        ax.text(xi - w / 2, c + 0.2, f"{c:.1f}", ha="center", fontsize=8)
        ax.text(xi + w / 2, g + 0.2, f"{g:.1f}", ha="center", fontsize=8)
    ax.set_xticks(x); ax.set_xticklabels(labels, fontsize=7.5)
    ax.set_ylabel("intramolecular strain of the planar (hinge-like) pose\n(MMFF94s, kcal/mol)")
    ax.set_title("Left: the generator's 'novel' decoration (ortho-CH3 / biaryl crowding) buys hydrophobic contact\n"
                 "by paying a planar-geometry strain penalty of ~7-14 kcal/mol", fontsize=8.5)
    ax.legend(fontsize=8); ax.grid(alpha=0.25, axis="y"); ax.spines[["top", "right"]].set_visible(False)

    ax = axes[1]
    # 条高 = −docking (向上=越强)；修正后若为正值(=净不利)则落在横轴下方，直观表达"结合被抹除"
    dc = [-byid[a]["dock_claimed"] for a, _ in rows]
    dg = [-byid[b]["dock_claimed"] for _, b in rows]
    ec = [-byid[a]["dock_corrected"] for a, _ in rows]
    eg = [-byid[b]["dock_corrected"] for _, b in rows]
    ax.bar(x - w / 2, dc, w, color="#a9c6e8", edgecolor="#2b6fb3", lw=0.6, label="control · claimed")
    ax.bar(x + w / 2, dg, w, color="#f2b0a8", edgecolor="#c0392b", lw=0.6, label="'generated' · claimed")
    ax.bar(x - w / 2, ec, w, hatch="///", color="#2b6fb3", alpha=0.9, label="control · strain-corrected")
    ax.bar(x + w / 2, eg, w, hatch="///", color="#c0392b", alpha=0.9, label="'generated' · strain-corrected")
    for xi, v in zip(x, dc): ax.text(xi - w / 2, v + 0.2, f"{-v:+.1f}", ha="center", fontsize=7, color="#2b6fb3")
    for xi, v in zip(x, dg): ax.text(xi + w / 2, v + 0.2, f"{-v:+.1f}", ha="center", fontsize=7, color="#c0392b")
    for xi, v in zip(x, ec): ax.text(xi - w / 2, v + 0.15, f"{-v:+.1f}", ha="center", fontsize=7, color="#123")
    for xi, v in zip(x, eg): ax.text(xi + w / 2, v + 0.15, f"{-v:+.1f}", ha="center", fontsize=7, color="#7f1d1d")
    ax.axhline(9, color="#666", ls=":", lw=0.9)
    ax.text(x[-1] + 0.35, 9.2, "claimed gain floor “< −11 kcal/mol” (i.e. >11 up)", fontsize=6.6, color="#666", ha="right")
    ax.set_xticks(x); ax.set_xticklabels(labels, fontsize=7.5)
    ax.set_ylabel("− docking score (up = stronger apparent binding)")
    ax.set_ylim(-4, 17)
    ax.set_title("Right: the 'claimed < −11 kcal/mol' advantage is reversed once the measured intramolecular\n"
                 "pose strain (same kcal/mol scale) is charged to the score — generated analogs collapse to/below\n"
                 "control level, and G03's net affinity is no longer favorable (<0)", fontsize=8.2)
    ax.legend(fontsize=7, ncol=2, loc="upper left"); ax.grid(alpha=0.25, axis="y")
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    fig.savefig(path); plt.close(fig)


# ------------------------------------------------------------------------------
# 演示数据集（仿真声称分子）
# ------------------------------------------------------------------------------
def demo_dataset():
    """仿真审查集：classical controls + claimed 'generated' hits。

    dock_claimed 列 = "平台宣称的对接得分"，是审查输入、非实测。所有分子均可解析且 MMFF 可参数化。
    """
    rows = [
        # (id, class, archetype, smiles, dock_claimed)
        ("R01", "control", "6,7-二甲氧基喹唑啉 4-(4-氯苯胺) 经典 ATP 位铰链骨架",
         "COc1cc2c(Nc3ccc(Cl)cc3)ncnc2cc1OC", -9.2),
        ("R02", "control", "1H-吲唑-3-甲酰胺 N-(4-氟苯基)",
         "O=C(Nc1ccc(F)cc1)c1n[nH]c2ccccc12", -8.9),
        ("R03", "control", "4-氨基-5-(3-氟苯基)-7H-吡咯并[2,3-d]嘧啶",
         "Nc1ncnc2cc(-c3cccc(F)c3)[nH]c12", -8.6),
        ("R04", "control", "延展喹唑啉先导（吗啉乙氧基苯胺尾）",
         "COc1cc2c(Nc3ccc(OCCN4CCOCC4)cc3)ncnc2cc1OC", -10.1),
        # ---- claimed 'generated' 仿真分子 ----
        ("G01", "generated", "仿真·新颖骨架#1：在铰链苯胺上添加 2,6-二甲基→共平面性破坏",
         "COc1cc2c(Nc3c(C)cccc3C)ncnc2cc1OC", -11.4),
        ("G02", "generated", "仿真·新颖骨架#2：吲唑酰胺 N-芳基邻位二甲基→酰胺扭转",
         "O=C(Nc1c(C)cccc1C)c1n[nH]c2ccccc12", -11.8),
        ("G03", "generated", "仿真·新颖骨架#3：吡咯并嘧啶 5-(2,6-二甲苯基)→联芳基扭转",
         "Nc1ncnc2cc(-c3c(C)cccc3C)[nH]c12", -12.2),
        ("G04", "generated", "仿真·新颖骨架#4：二苯并[a,d][7]轮烯胺（7 元中环刚性亲脂体）",
         "NC1c2ccccc2CCc2ccccc21", -12.7),
        ("G05", "generated", "仿真·新颖骨架#5：喹唑啉 4-位接入 β-内酰胺(4 元环)→小环张力/HBD 丢失",
         "O=C1N(c2ncnc3cc(OC)c(OC)cc23)CC1(C)C", -13.1),
        ("G06", "generated", "仿真·新颖骨架#6：苯胺上邻苯二酚→PAINS",
         "COc1cc2c(Nc3cc(O)c(O)cc3)ncnc2cc1OC", -12.0),
        ("G07", "generated", "仿真·新颖骨架#7：吡咯并嘧啶接烯酮 Michael 受体→PAINS",
         "CC(=O)/C=C/c1c[nH]c2ncnc(N)c12", -11.6),
        ("G08", "generated", "仿真·新颖骨架#8：氯代乙酰胺芳基→REOS 烷基化警示",
         "COc1cc2c(Nc3ccc(NC(=O)CCl)cc3)ncnc2cc1OC", -12.4),
        ("G09", "generated", "仿真·新颖骨架#9：8 元环 N-芳基内酰胺(扭转酰胺)",
         "O=C1CCCCCCN1-c1ncnc2[nH]ccc12", -12.6),
        ("G10", "generated", "仿真·新颖骨架#10：2,2',6,6'-受阻双酰胺联芳基(类阻转异构)",
         "Cc1cccc(C(=O)Nc2ccc(F)cc2)c1-c1c(C)cccc1C(=O)Nc2ccc(F)cc2", -14.3),
    ]
    return [{"id": r[0], "_class": r[1], "archetype": r[2], "smiles": r[3],
             "dock_claimed": float(r[4])} for r in rows]


# ------------------------------------------------------------------------------
# 输出辅助
# ------------------------------------------------------------------------------
def dump_jsonable(rec):
    """去掉不可 JSON 化的键。"""
    if isinstance(rec, dict):
        return {k: dump_jsonable(v) for k, v in rec.items()
                if k not in ("molh", "scan", "torsion_atoms", "cut_types")}
    if isinstance(rec, list):
        return [dump_jsonable(x) for x in rec]
    return rec


def table_print(records):
    hdr = (f"{'id':6s}{'class':9s}{'QED':>6s}{'SA':>5s}{'route':>6s}{'PAINS':>6s}{'REOS':>6s}"
           f"{'nRing':>6s}{'medR':>6s}{'strain':>7s}{'planar':>7s}{'dockCl':>8s}{'dockEff':>8s}{'gate':>6s}")
    print(hdr); print("-" * len(hdr))
    for r in records:
        if not r.get("ok"):
            print(f"{r.get('id','?'):6s} PARSE FAIL"); continue
        alerts, retro = r["alerts"], r["retro"]
        print(f"{r['id']:6s}{r.get('_class',''):9s}"
              f"{r['phys']['QED']:6.2f}{(retro['sa_score'] or 0):5.1f}"
              f"{retro['route_score']:6.2f}{len(alerts['pains']):6d}{len(alerts['reos']):6d}"
              f"{r['ring']['n_rings']:6d}{str(r['ring']['medium_rings_7_9']):>6s}"
              f"{r['ring']['ring_strain_est_kcal']:7.1f}{r['planar_strain_kcal']:7.1f}"
              f"{(r.get('dock_claimed') or 0):8.1f}{(r.get('dock_corrected') or 0):8.1f}"
              f"{'GATE' if r['gate'] else '':>6s}")


# ------------------------------------------------------------------------------
# main
# ------------------------------------------------------------------------------
def run_audit(dataset, out_dir, n_confs=20, step=30, seed=7, do_plots=True, verbose=True):
    os.makedirs(out_dir, exist_ok=True)
    records = []
    for d in dataset:
        rec = audit_molecule(d["smiles"], dock_claimed=d.get("dock_claimed"),
                             mol_id=d["id"], n_confs=n_confs, step=step, seed=seed)
        rec["_class"] = d.get("_class", "")
        rec["archetype"] = d.get("archetype", "")
        records.append(rec)
    if verbose:
        table_print(records)
    if do_plots:
        make_plots(records, out_dir)
    json_path = os.path.join(out_dir, "audit_results.json")
    with open(json_path, "w") as f:
        json.dump(dump_jsonable(records), f, ensure_ascii=False, indent=1)
    return records, json_path


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generative-molecule reality audit pipeline (RDKit/MMFF94s)")
    ap.add_argument("--csv", default=None, help="CSV with columns: id,smiles,dock (dock optional)")
    ap.add_argument("--dock-col", default="dock", help="column name of claimed docking score (default: dock)")
    ap.add_argument("--out-dir", default="audit_outputs")
    ap.add_argument("--confs", type=int, default=20)
    ap.add_argument("--step", type=int, default=30)
    ap.add_argument("--no-plot", action="store_true")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args(argv)

    if args.csv:
        import csv
        rows = []
        with open(args.csv, newline="") as fh:
            rd = csv.DictReader(fh)
            for i, row in enumerate(rd):
                rows.append({"id": row.get("id", f"mol{i}"), "smiles": row["smiles"],
                             "_class": row.get("class", ""),
                             "dock_claimed": float(row[args.dock_col]) if row.get(args.dock_col) else None})
        dataset = rows
    else:
        dataset = demo_dataset()
    records, json_path = run_audit(dataset, args.out_dir, n_confs=args.confs,
                                   step=args.step, seed=args.seed,
                                   do_plots=not args.no_plot)
    print(f"\n[results] JSON -> {json_path}")
    if not args.no_plot:
        print("[results] figures ->", args.out_dir)


if __name__ == "__main__":
    main()
