/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Asserts that the Team ID configured for this build actually reached the packaged main bundle.
//
// `electron.vite.config.ts` bakes it in with a `define`, and the main process is code-split, so the literal
// lands in a chunk rather than in `out/main/index.js`. Checking one file gives a false negative (it did
// exactly that once: `grep -c` said 0 while the chunk held the value). This walks every built main chunk.
//
// Empty expected value means "not configured", which is a legitimate state (ad-hoc build) — report and pass.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)

/** @returns {string} */
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const dir = readArg('dir', 'out/main')
const expected = readArg('expected', '').trim()

/**
 * @param {string} root
 * @param {string[]} [out]
 * @returns {string[]}
 */
const walk = (root, out = []) => {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (path.endsWith('.js')) out.push(path)
  }
  return out
}

if (!expected) {
  console.log(
    '[baked-team-id] PURESCIENCE_MAC_TEAM_ID is not set — the bundle carries no team id (ad-hoc).'
  )
  process.exit(0)
}

let files = []
try {
  files = walk(dir)
} catch (error) {
  console.error(`[baked-team-id] cannot read ${dir}: ${error.message}`)
  process.exit(1)
}

const hits = files.filter((path) => readFileSync(path, 'utf8').includes(expected))
if (hits.length === 0) {
  console.error(
    `[baked-team-id] FAIL: ${expected} does not appear in any of ${files.length} main chunks under ${dir}. ` +
      'The define did not reach the bundle, so a packaged app could never allow an in-place update.'
  )
  process.exit(1)
}

console.log(`[baked-team-id] ok: team id found in ${hits.length} of ${files.length} main chunks.`)
