# -*- coding: utf-8 -*-
"""
classifier_v2.py  ——  模型进化实验 · 版本 v2（按 auto_fix_convergence 技能自动补丁）

相对 v1 的补丁（C 阶段要求）:
  * max_iter   : 50 -> 2000   （放宽迭代上限，消除任何可能的迭代截断风险）
  * class_weight: None -> 'balanced' （对类别权重做再平衡，降低多数类先验影响）

数据契约与 v1 完全一致 (DATA_SEED=999, SPLIT_SEED=42)，确保与 v1 在同一
Python 进程内按同一测试集逐样本配对比较 (ROC-AUC + McNemar)。
"""
import warnings

import numpy as np
from sklearn.datasets import make_classification
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, classification_report,
                             confusion_matrix, roc_auc_score)
from sklearn.model_selection import train_test_split

DATA_SEED = 999
SPLIT_SEED = 42

# ---- 1. 数据生成（与 v1 完全一致）----
X, y = make_classification(n_samples=1000, n_features=20, n_classes=2,
                           random_state=DATA_SEED)
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.3, random_state=SPLIT_SEED, stratify=y)

# ---- 2. 自动修复后的 LogisticRegression (v2) ----
clf = LogisticRegression(max_iter=2000, C=1e6, class_weight="balanced",
                         random_state=0)
with warnings.catch_warnings(record=True) as wlist:
    warnings.simplefilter("always")
    clf.fit(X_train, y_train)

conv_msgs = [str(w.message).strip().replace("\n", " | ")
             for w in wlist if issubclass(w.category, ConvergenceWarning)]
n_iter = int(clf.n_iter_[0])
convergence_warning = len(conv_msgs) > 0
hit_iter_cap = n_iter >= clf.max_iter

y_pred = clf.predict(X_test)
y_prob = clf.predict_proba(X_test)[:, 1]
y_pred_tr = clf.predict(X_train)

# ---- 3. 评估输出 ----
print("=" * 74)
print("[classifier_v2] 拟合与评估结果  "
      "(max_iter=2000, C=1e6, class_weight='balanced')")
print("=" * 74)
print(f"n_iter               : {n_iter}  (上限={clf.max_iter}, "
      f"达到上限={hit_iter_cap})")
print(f"ConvergenceWarning   : {'触发' if convergence_warning else '未触发'}")
for m in conv_msgs:
    print("   警告内容: " + m)
print(f"训练集准确率         : {accuracy_score(y_train, y_pred_tr):.4f}")
print(f"测试集准确率         : {accuracy_score(y_test, y_pred):.4f}")
print(f"测试集 ROC-AUC       : {roc_auc_score(y_test, y_prob):.4f}")
print("--- classification_report ---")
print(classification_report(y_test, y_pred, digits=4))
print("--- confusion_matrix ---")
print(confusion_matrix(y_test, y_pred))
print("=" * 74)

STORED = dict(
    version="v2",
    params=dict(max_iter=2000, C=1e6, class_weight="balanced", solver="lbfgs"),
    n_iter=n_iter,
    hit_iter_cap=hit_iter_cap,
    convergence_warning=convergence_warning,
    warning_texts=conv_msgs,
    y_test=y_test.copy(),
    y_pred=y_pred.copy(),
    y_prob=y_prob.copy(),
    train_acc=float(accuracy_score(y_train, y_pred_tr)),
    test_acc=float(accuracy_score(y_test, y_pred)),
    roc_auc=float(roc_auc_score(y_test, y_prob)),
)
