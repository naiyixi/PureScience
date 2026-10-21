---
name: bionexus-variant-interpretation
contract: '{"id":"bionexus-variant-interpretation","aliases":["变异解读","ACMG 组合","variant interpretation"],"requires":["input:variant_list"],"produces":["review:variant"],"failure_policy":{"missing_state":"Provide caller-supplied variant codes first; this skill combines ACMG codes, it does not call variants or auto-assign PM2/PP3."}}'
description: Only if the user explicitly asked for an ACMG combination calculator on caller-supplied codes. No CLIA, no auto-PM2/PP3. Not a default analysis skill.
---

# Variant combination (research-use)

## What is real

- Deterministic ACMG combination given a code set.
- Tavtigian posterior from those codes (prior 0.10).

## What is withheld

- Missing gnomAD AF → **no PM2**.
- `in_silico_damaging` default is `None` → **no PP3/BP4**.
- Predicted nonsense/frameshift → **no PVS1** unless `lof_is_known_mechanism=True`.

## Reports

Markdown is a **research interpretation summary**. It must not contain a CLIA ID, CAP number, or laboratory letterhead.
