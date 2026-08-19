#!/usr/bin/env bash
# PureScience 科学计算环境一键安装脚本 (macOS, Apple Silicon)
# 安装: rdkit/openbabel/meeko/OpenMM/numpy/scipy/pandas/matplotlib + ambertools(antechamber) + AutoDock Vina
# 用法: bash setup-science-env.sh
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
unset PYTHONPATH

VENV=~/.cache/purescience/md-venv
MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple
echo "=== PureScience 科学计算环境安装器 ==="

echo "[1/6] 检查 Python 3.12+ ..."
PY=$(command -v /opt/homebrew/bin/python3 || command -v python3)
$PY --version

echo "[2/6] 创建独立 Python 环境 ..."
if [ ! -d "$VENV/bin" ]; then
  $PY -m venv "$VENV"
  echo "  已创建: $VENV"
else
  echo "  已存在: $VENV"
fi

echo "[3/6] 安装核心科学包 (清华镜像) ..."
"$VENV/bin/pip" install --index-url "$MIRROR" --no-cache-dir \
  numpy scipy pandas rdkit openbabel-wheel meeko gemmi openmm mdtraj matplotlib pdbfixer 2>&1 | tail -2

echo "[4/6] 安装 ambertools (antechamber/parmchk2/tleap, Rosetta) ..."
MMBIN=~/.cache/purescience/bin/micromamba-pkg/bin/micromamba
if [ ! -x "$MMBIN" ]; then
  echo "  下载 micromamba ..."
  mkdir -p ~/.cache/purescience/bin
  cd ~/.cache/purescience/bin
  curl -sL --max-time 300 -o mm.tar.bz2 "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/osx-arm64/micromamba-2.8.1-0.tar.bz2"
  mkdir -p micromamba-pkg && tar xjf mm.tar.bz2 -C micromamba-pkg && rm mm.tar.bz2
fi
export MAMBA_ROOT_PREFIX=~/.cache/purescience/mamba-root
if [ ! -x ~/.cache/purescience/amber-env/bin/antechamber ]; then
  "$MMBIN" create -y -p ~/.cache/purescience/amber-env --platform=osx-64 \
    -c "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge" \
    -c "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/bioconda" \
    ambertools 2>&1 | tail -2
fi

echo "[5/6] 安装 AutoDock Vina (conda-forge 二进制) ..."
VINA=~/.cache/purescience/bin/vina-conda/bin/vina
if [ ! -x "$VINA" ]; then
  cd ~/.cache/purescience/bin
  curl -sL --max-time 300 -o vina.tar.bz2 "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/osx-64/vina-1.2.2-py310he60a7ad_1.tar.bz2"
  mkdir -p vina-conda && tar xjf vina.tar.bz2 -C vina-conda && rm vina.tar.bz2
  # boost 依赖
  curl -sL --max-time 300 -o boost.tar.bz2 "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/osx-64/boost-cpp-1.74.0-hf3dc895_6.tar.bz2"
  mkdir -p boost-cpp && tar xjf boost.tar.bz2 -C boost-cpp && rm boost.tar.bz2
  install_name_tool -add_rpath "$PWD/boost-cpp/lib" vina-conda/bin/vina 2>/dev/null || true
  chmod +x vina-conda/bin/vina
fi

echo "[6/6] 验证 ..."
"$VENV/bin/python" -c "import rdkit, openbabel, meeko, openmm, numpy, pandas, matplotlib; print('Python 科学包 OK: rdkit %s / openmm %s' % (rdkit.__version__, openmm.__version__))"
arch -x86_64 ~/.cache/purescience/amber-env/bin/antechamber --version 2>&1 | head -1
~/.cache/purescience/bin/vina-conda/bin/vina --version 2>&1 | head -1

echo ""
echo "=== 安装完成 ==="
echo "Python 环境: $VENV (notebook 中绑定此运行时)"
echo "antechamber: ~/.cache/purescience/amber-env/bin/ (Rosetta)"
echo "vina:        ~/.cache/purescience/bin/vina-conda/bin/vina"
echo "提示: notebook 执行需在会话中 notebook_bind_runtime 绑定 md-venv"
