# -*- coding: utf-8 -*-
"""
classifier_v1.py  ——  模型进化实验 · 版本 v1（故意劣化 / 挖坑版）

设计参数（A 阶段要求）:
  * max_iter = 50  : 迭代上限远小于收敛所需，lbfgs 在达到容差前被强制截断
  * C = 1e6        : 1/C = 1e-6，正则强度≈无，系数幅值不受约束

运行本文件完成: 数据生成 -> 固定划分 -> 拟合 -> 评估(classification_report +
混淆矩阵)。同时把 y_test / y_pred / y_prob 等写入 STORED 字典，供后续在
同一 Python 进程中与 v2 按样本逐条配对比较 (ROC-AUC + McNemar)。

数据契约 (与 v2 完全一致，保证同一测试集):
  DATA_SEED=999 -> make_classification(n_samples=1000, n_features=20, n_classes=2)
  SPLIT_SEED=42 -> train_test_split(test_size=0.3, stratify=True)
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

# ---- 1. 数据生成 ----
X, y = make_classification(n_samples=1000, n_features=20, n_classes=2,
                           random_state=DATA_SEED)
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.3, random_state=SPLIT_SEED, stratify=y)

# ---- 2. 故意劣化的 LogisticRegression (v1) ----
clf = LogisticRegression(max_iter=50, C=1e6, random_state=0)
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
print("[classifier_v1] 拟合与评估结果  (max_iter=50, C=1e6, class_weight=None)")
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
    version="v1",
    params=dict(max_iter=50, C=1e6, class_weight=None, solver="lbfgs"),
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
