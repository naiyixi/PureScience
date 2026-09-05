# PureScience — Zenodo DOI Archiving Runbook (O5)

Each stable PureScience release should get a **citable, immutable DOI** so papers, grants, and
reports can reference an exact version. Zenodo archives GitHub repositories by tag and mints a DOI
per upload. This runbook codifies the per-release flow.

## Principles

- **One archive per stable release tag** (`vX.Y.Z`). Nightly/pre-release tags are not archived.
- **No secrets.** Zenodo uploads the repository contents from the tag. Never commit credentials,
  tokens, or keys anywhere under the repo (see SECURITY.md). If a secret is ever found in history,
  fix the leak before archiving.
- **Brand-safe by construction:** this runbook mentions no other product. The archived README is
  the public-facing one.

## One-time setup (owner)

1. Create a Zenodo account and link GitHub: **Zenodo → GitHub → Settings → Link GitHub account**,
   grant access to the `naiyixi/PureScience` repository.
2. Optional, for API automation: create a Zenodo **Personal Access Token**
   (token scope: `deposit:actions`, `deposit:write`) and store it in the local environment as
   `ZENODO_TOKEN` — never in the repository.
3. Decide the archive owner/community (e.g. an institutional community or the project's own space)
   and record it in the release checklist.

## Per-release flow

### Automated (GitHub → Zenodo, no token needed)

1. Push the stable tag `vX.Y.Z` (existing release process).
2. In Zenodo's GitHub integration, toggle the repo **On** — Zenodo then watches for tags. New
   stable tags that match the configured pattern produce a new upload automatically.
3. After the GitHub Release completes, open the Zenodo record page for the new version and:
   - confirm the archive title reads **PureScience** and the version reads `vX.Y.Z`;
   - set access to **Public** and **Published**;
   - copy the new DOI.

### Manual/API fallback (if GitHub integration is disabled)

```bash
# With ZENODO_TOKEN set:
curl -s -X POST -H "Authorization: Bearer $ZENODO_TOKEN" \
  "https://zenodo.org/api/deposit/depositions" \
  -o /tmp/zenodo-deposit.json
DEPOSIT_ID=$(python3 -c "import json;print(json.load(open('/tmp/zenodo-deposit.json'))['id'])")

curl -s -X POST \
  -H "Authorization: Bearer $ZENODO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"metadata":{"upload_type":"software","title":"PureScience","version":"vX.Y.Z","license":"Apache-2.0","description":"PureScience — an open-source, local-first, model-agnostic AI research workbench for reproducible scientific discovery."}}' \
  "https://zenodo.org/api/deposit/depositions/$DEPOSIT_ID/files" >/dev/null

# Archive the exact tag:
git archive --format=zip --prefix=purescience-vX.Y.Z/ vX.Y.Z -o /tmp/purescience-vX.Y.Z.zip
curl -s -X POST \
  -H "Authorization: Bearer $ZENODO_TOKEN" \
  -F "file=@/tmp/purescience-vX.Y.Z.zip" \
  "https://zenodo.org/api/deposit/depositions/$DEPOSIT_ID/files" >/dev/null
```

Then publish via the Zenodo UI (or `POST .../actions/publish`).

## After archiving

- Record the DOI in the release checklist and in the version's release notes (a single line:
  `Archived DOI: https://doi.org/10.5281/zenodo.<id>`).
- Update `docs/roadmap` notes only if the archive process itself changed; do not bloat READMEs with
  per-version DOIs — one canonical "Cite as" line that points at the latest DOI is enough.

## Dry-run before first real archive

1. Create the first archive **after** the next stable release tag with the automated flow.
2. Before publishing, review the draft record for: repository contents completeness (the tag's
   tree), README version consistency (PureScience vX.Y.Z), and that no private files slipped in
   (the archive is the tag tree, so it matches the public repo by construction).
