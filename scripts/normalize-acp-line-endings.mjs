// Normalize @agentclientprotocol/claude-agent-acp dist line endings to LF before
// patch-package applies patches/claude-agent-acp+0.60.0.patch.
//
// The npm tarball ships CRLF line endings; the patch is authored in LF. patch-package
// matches bytes exactly, so on any clean `npm ci` the patch fails with "Failed to apply
// patch". Normalizing the two dist files to LF first makes the patch apply deterministically
// on every platform (macOS, Linux, Windows).
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const packageDir = require.resolve('@agentclientprotocol/claude-agent-acp/package.json').replace(/package\.json$/, '')
const targets = ['dist/acp-agent.js', 'dist/acp-agent.d.ts']

for (const relative of targets) {
  const absolute = new URL(relative, new URL(`file://${packageDir}`)).pathname
  let data = await readFile(absolute)
  const original = data
  data = data.toString('utf8').replace(/\r\n/g, '\n')
  if (data !== original.toString('utf8')) {
    await writeFile(absolute, data, 'utf8')
    console.log(`[normalize-acp-line-endings] converted ${relative} to LF`)
  }
}
