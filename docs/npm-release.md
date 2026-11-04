# npm Package Release

> [!NOTE]
> The package is published unscoped as `purescience`. An earlier scoped name (`@zerolink/purescience`)
> could not be created: the registry answered `E404` on the first `PUT`, which is what npm returns when
> the scope's organization does not exist or when a scoped token may only publish to packages that are
> already there. A scope buys nothing here — one package, one owner — and costs an organization plus a
> wider token, so the release uses the plain name.

The `purescience` SDK and CLI use a version and release tag namespace independent of the
desktop application. Desktop releases use `v*`; npm releases use `npm-v*`.

## One-time setup

1. The publishing account owns `purescience` on npm. No organization or scope is involved.
2. Create a GitHub Environment named `npm`. Add required reviewers to keep publishing behind an
   explicit approval.
3. Because Trusted Publisher cannot be configured until the package exists, add a short-lived npm
   publish token as the `NPM_TOKEN` secret in that environment for the first release only.
4. After the first release, configure the package's npm Trusted Publisher with:
   - organization or user: the publishing account
   - repository: `purescience`
   - workflow: `publish-npm.yml`
   - environment: `npm`
5. Delete `NPM_TOKEN` from the GitHub Environment. Future releases authenticate with GitHub OIDC;
   no long-lived npm credential is required.

The publish job requests `id-token: write` and uses `npm publish --provenance`, so npm records signed
provenance for the released tarball.

## Release process

1. Update `packages/purescience/package.json` to the intended semantic version in a pull request.
2. Merge the pull request after the CLI/SDK tests and package-content checks pass.
3. Run **Publish npm package** manually on the target commit. Manual runs build, dry-run publish, and
   upload the tarball without changing npm.
4. Create and push a tag that exactly matches `npm-v<package-version>`:

   ```bash
   git tag -a npm-v0.1.0 -m "purescience 0.1.0"
   git push origin npm-v0.1.0
   ```

5. Approve the protected `npm` environment. The workflow publishes the same tarball produced by the
   verify job.

`scripts/validate-npm-release.mjs` rejects mismatched tags before the publish job can start. npm also
rejects attempts to overwrite an existing version, so every release requires a version increment.
