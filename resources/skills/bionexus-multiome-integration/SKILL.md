---
name: bionexus-multiome-integration
contract: '{"id":"bionexus-multiome-integration","aliases":["多组学整合","multiome","multiome integration"],"requires":["input:expression_matrix"],"produces":["data:multiome_sketch"],"failure_policy":{"missing_state":"Load both modalities first; this is a grade-C sketch, not a default analysis path."}}'
description: Only if the user explicitly asked for a grade-C multiome sketch. ExtraTrees co-expression, not SCENIC+. Not a default analysis skill.
---

# Multiome sketches

Function names are historical. The `method` field is authoritative:

- ExtraTrees(n_estimators=10), not GRNBoost2
- Top-5% overlap fraction, not AUCell
- Inverse neighbor-distance weights, not Seurat v4 WNN
- No JASPAR scan unless the caller supplies a peak×motif matrix
