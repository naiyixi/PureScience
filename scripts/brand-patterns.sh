#!/usr/bin/env bash
# Shared brand zero-trace pattern list for PureScience git hooks.
# Single source of truth consumed by scripts/pre-push-checks.sh (tracked file
# content) and scripts/commit-msg-checks.sh (commit message text). This file is
# self-excluded from the content scan because it legitimately lists the words.
BRAND_PATTERNS='aipoch|open-science|openscience|OpenScience|open_science|Claude Science|claude-science|CSSwitch|K-Dense|scientific-agent-skills|medical-research-skills|Anthropic research connectors|Claude Connectors Directory|upstream|Upstream|上游|术语统一'
