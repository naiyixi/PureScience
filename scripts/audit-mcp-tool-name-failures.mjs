/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Classifies every "No such tool available" line the app itself logged, so the numbers in
// docs/evidence/2026-10-11-app-mcp-server-name-consistency.md stay re-derivable instead of living
// only in a session transcript.
//
//   node --experimental-strip-types scripts/audit-mcp-tool-name-failures.mjs [<logDir>]
//
// <logDir> defaults to ~/Library/Logs/PureScience (the packaged app's main*.log). The auditor reads
// the names from the app's own module — no second copy of the catalog — and asks, for each failed
// call, whether that same spelling is the name the app renders to the framework today.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  appMcpToolIdentities,
  modelFacingAppMcpToolName
} from '../src/main/agent-framework/app-mcp-names.ts'
import { FIGURE_MCP_SERVER_NAME, FIGURE_REVIEW_TOOL_NAME } from '../src/shared/figure.ts'
import { REVIEWER_MCP_SERVER_NAME, REVIEWER_MCP_TOOLS } from '../src/shared/reviewer.ts'

const logDir = process.argv[2] ?? join(process.env.HOME, 'Library/Logs/PureScience')

// A framework renders a server name into the tool name it hands the model (mcp__<server>__<tool>),
// which is the spelling the model either copies or mis-guesses. Figure and reviewer are app-owned but
// are not declared in the naming module's catalog (the figure review tool and the reviewer's identities
// are not grantable session capabilities), so they are added here the same way the module itself
// resolves them: by their canonical name plus the hyphen spelling grants and configs were written with.
const identities = [
  ...appMcpToolIdentities(),
  `${FIGURE_MCP_SERVER_NAME}/${FIGURE_REVIEW_TOOL_NAME}`,
  ...Object.values(REVIEWER_MCP_TOOLS).map((tool) => `${REVIEWER_MCP_SERVER_NAME}/${tool}`)
].sort()

const splitIdentity = (identity) => {
  const separator = identity.indexOf('/')
  return { server: identity.slice(0, separator), tool: identity.slice(separator + 1) }
}

const separatorFolded = (value) => value.replace(/-/gu, '_')
const declaredServers = new Set(identities.map((identity) => splitIdentity(identity).server))
const identityNames = new Set(identities)

const classify = (guessed) => {
  const parts = /^mcp__(.+)__(.+)$/u.exec(guessed)
  if (!parts) return { kind: 'unparsed', detail: '' }
  const [, rawServer, tool] = parts
  // Only a hyphen folding to an underscore keeps the name an app-owned server: `mcp__purescience__x`
  // and `mcp__purescience__notebook__x` are names the app never rendered, and a foreign server such as
  // `mcp__purescience-pubmed__x` is not app-owned either.
  const server = separatorFolded(rawServer)
  if (!declaredServers.has(server)) return { kind: 'not-app-server', detail: `server=${rawServer}` }
  if (!identityNames.has(`${server}/${tool}`)) {
    return { kind: 'no-such-leaf', detail: `server=${server}` }
  }
  // The name the app renders to claude-code for that identity today: a guess equal to it resolves.
  const facing = modelFacingAppMcpToolName('claude-code', server, tool)
  if (guessed === facing) return { kind: 'callable-now', detail: facing }
  // The guess differs from the rendered name by a separator only, and the rendered name carries no
  // hyphen: the model guessed the hyphenated form on its own, so the rename does not make it work.
  return { kind: 'wrong-separator', detail: `rendered=${facing}` }
}

const failures = []
for (const file of readdirSync(logDir).filter((entry) => entry.endsWith('.log'))) {
  for (const line of readFileSync(join(logDir, file), 'utf8').split('\n')) {
    if (!line.includes('No such tool available')) continue
    const guessed = /No such tool available: ([^ <"\\]*)/u.exec(line)?.[1]
    if (!guessed) continue
    const recorded = /"tool":"([^"]*)"/u.exec(line)?.[1] ?? ''
    const at = /"t":"([^"]*)"/u.exec(line)?.[1] ?? ''
    failures.push({ file, at, recorded, guessed, ...classify(guessed) })
  }
}

const buckets = new Map()
for (const failure of failures) {
  const group = buckets.get(failure.kind) ?? []
  group.push(failure)
  buckets.set(failure.kind, group)
}

const count = (kind) => failures.filter((failure) => failure.kind === kind).length

console.log(`logDir=${logDir}`)
console.log(`identities=${identities.length}  failure lines=${failures.length}`)
if (failures.length) {
  const times = failures.map((failure) => failure.at).sort()
  console.log(`window=${times[0]} .. ${times[times.length - 1]}`)
}
for (const [kind, group] of [...buckets].sort()) {
  const names = new Map()
  for (const failure of group) names.set(failure.guessed, (names.get(failure.guessed) ?? 0) + 1)
  console.log(`\n${kind}: ${group.length}`)
  for (const [name, nameCount] of [...names].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(nameCount).padStart(2)}  ${name}`)
  }
}
console.log(
  `\nsummary: total=${failures.length} callable_now=${count('callable-now')}` +
    ` wrong_separator=${count('wrong-separator')}` +
    ` no_such_leaf=${count('no-such-leaf')}` +
    ` not_app_server=${count('not-app-server')}`
)
