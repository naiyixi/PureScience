#!/usr/bin/env node
// Generates the version.json client manifest for a release's installers and writes it into the
// artifacts directory for upload. The installed app's manifest-update flow polls
// <repo>/releases/latest/download/version.json (see APP.update.manifestUrl) — that asset must be
// re-published on EVERY release or in-app "check for updates" fails with "Manifest fetch failed:
// 404". The stable win/linux/mac in-place updaters use the electron-updater feeds (latest*.yml),
// which release.yml already uploads; this file covers the UpdateService manifest flow (mac
// local/nightly/unsigned builds and the fallback path).
//
// Usage:
//   node scripts/generate-version-manifest.mjs <artifacts-dir> [version]
//   version defaults to the GITHUB_REF_NAME tag (v-prefix stripped); the directory is scanned for
//   the known installer names, and every found platform becomes a downloads entry keyed by the
//   client's platformDownloadKey() values (mac-arm64/mac-x64/win-x64/linux-x64-deb,
//   plus linux-x64-appimage when the AppImage is present).
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const REPO = 'naiyixi/PureScience'
const RELEASE_URL = `https://github.com/${REPO}/releases/download`

const versionFromRef = (ref = process.env.GITHUB_REF_NAME ?? '') =>
  ref.startsWith('v') ? ref.slice(1) : ref

// Installer name -> downloads key. Version appears in every name, so each matcher takes it.
const INSTALLERS = [
  { key: 'mac-arm64', match: (v) => `zerolink-purescience-${v}-mac-arm64.dmg` },
  { key: 'mac-x64', match: (v) => `zerolink-purescience-${v}-mac-x64.dmg` },
  { key: 'win-x64', match: (v) => `zerolink-purescience-${v}-win-x64-setup.exe` },
  { key: 'linux-x64-deb', match: (v) => `zerolink-purescience_${v}_amd64.deb` },
  { key: 'linux-x64-appimage', match: (v) => `zerolink-purescience-${v}-linux-x86_64.AppImage` }
]

const sha256 = async (file) =>
  createHash('sha256').update(await readFile(file)).digest('hex')

const main = async () => {
  const [, , dirArg, versionArg] = process.argv
  if (!dirArg) {
    console.error('usage: generate-version-manifest.mjs <artifacts-dir> [version]')
    process.exit(1)
  }
  const dir = resolve(dirArg)
  const version = versionArg?.trim() || versionFromRef()
  if (!version) {
    console.error('version required (argument or GITHUB_REF_NAME)')
    process.exit(1)
  }
  const tag = `v${version}`
  const files = await readdir(dir)
  const downloads = {}
  const baseUrl = `${RELEASE_URL}/${tag}/`

  for (const { key, match } of INSTALLERS) {
    const name = match(version)
    if (!files.includes(name)) {
      console.warn(`skipping ${key}: ${name} not found in ${dir}`)
      continue
    }
    const path = join(dir, name)
    const [size, digest] = await Promise.all([stat(path), sha256(path)])
    downloads[key] = { url: `${baseUrl}${name}`, size: size.size, sha256: digest }
  }

  if (Object.keys(downloads).length === 0) {
    console.error(`no installers for version ${version} found in ${dir}`)
    process.exit(1)
  }

  const manifest = {
    version,
    releaseDate: new Date().toISOString(),
    notes: {
      zh: '更新说明见 GitHub Release 页面。',
      en: 'See the release notes on GitHub.'
    },
    downloads
  }
  const out = join(dir, 'version.json')
  await writeFile(out, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`==> ${out}: version=${version} platforms=${Object.keys(downloads).join(',')}`)
}

void main()
