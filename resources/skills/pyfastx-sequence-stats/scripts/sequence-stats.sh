#!/bin/bash
# Deterministic pyfastx wrapper for the `pyfastx-sequence-stats` skill.
#
# Exists so the numbers a report quotes come from one command with fixed arguments, not from whatever
# invocation an agent improvises. A missing tool is a stated failure (exit 3), never a reason to estimate.
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: sequence-stats.sh <sequence-file> [output.tsv]" >&2
  exit 2
fi

input="$1"

if [ ! -f "$input" ]; then
  echo "no such sequence file: $input" >&2
  exit 2
fi

# `pip install --user` puts the entry point in a per-version user bin that is often absent from PATH,
# so PATH is not the only place we look.
find_pyfastx() {
  if command -v pyfastx >/dev/null 2>&1; then
    command -v pyfastx
    return 0
  fi
  local candidate
  for candidate in "$HOME"/Library/Python/*/bin/pyfastx "$HOME"/.local/bin/pyfastx; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

PYFASTX="$(find_pyfastx || true)"
if [ -z "$PYFASTX" ]; then
  echo "pyfastx is not installed — run 'python3 -m pip install --user pyfastx' rather than estimating statistics" >&2
  exit 3
fi

if [ "$#" -ge 2 ]; then
  output="$2"
else
  base="${input%.gz}"
  output="${base%.*}.stats.tsv"
fi

"$PYFASTX" stat "$input" > "$output"

# The path is the deliverable: a caller that only sees this line can cite the artifact.
echo "$output"
