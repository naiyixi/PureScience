import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  PureScienceClient,
  type CapabilityReport,
  type ConnectorSurvey,
  type PermissionRequest,
  type ReadinessReport,
  type ReplayVersionReport,
  type RuntimeSurvey,
  type SessionPackageImport
} from './index.mjs'

// The published type file and the published runtime are two artifacts, and nothing in TypeScript forces
// them to agree: a method can ship in `index.mjs` and be missing from `index.d.ts` for months while every
// JavaScript caller keeps working. That is how nine methods — readiness, runtimes, connectors,
// capabilities, pending approvals, the approval answer, replay, and both package directions — ended up
// callable at runtime and invisible to a TypeScript consumer.
//
// Two guards, because one is not enough:
//   1. a read-source comparison of the declared method names against the runtime's, so drift fails here
//      with both lists in the message;
//   2. a typed consumer below, which `npm run typecheck:node` compiles — it fails with TS2339 the moment
//      a declaration goes missing, including a method this file's name list would not know about.

const here = dirname(fileURLToPath(import.meta.url))
const declarationPath = join(here, 'index.d.ts')

const declaredMethodNames = async (): Promise<string[]> => {
  const source = await readFile(declarationPath, 'utf8')
  const classStart = source.indexOf('export class PureScienceClient {')
  if (classStart === -1) throw new Error('index.d.ts no longer declares PureScienceClient.')
  const classBody = source.slice(classStart + 'export class PureScienceClient {'.length)
  const classEnd = classBody.indexOf('\n}')
  if (classEnd === -1) throw new Error('PureScienceClient declaration has no closing brace.')
  const body = classBody.slice(0, classEnd)
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\(/gm)]
    .map((match) => match[1]!)
    .filter((name) => name !== 'constructor')
}

// `request` and `throwResponseError` are transport internals, not SDK surface: the published declaration
// deliberately leaves them out. Naming them here is the point — a new method has to be a decision, not a
// silent omission.
const INTERNAL_METHODS = ['request', 'throwResponseError']

const runtimeMethodNames = (): string[] =>
  Object.getOwnPropertyNames(PureScienceClient.prototype).filter((name) => name !== 'constructor')

// Never called: it exists so the compiler checks every signature a consumer would write. Awaiting each
// result and naming its declared type is what turns "the method exists" into "the method returns what the
// declaration promises".
const typedConsumer = async (client: PureScienceClient): Promise<void> => {
  const readiness: ReadinessReport = await client.getReadiness()
  const runtimes: RuntimeSurvey = await client.listRuntimes()
  const connectors: ConnectorSurvey = await client.listConnectors()
  const capabilities: CapabilityReport = await client.getCapabilities()
  const scoped: CapabilityReport = await client.getCapabilities('session-1')
  const pending: PermissionRequest[] = await client.pendingPermissions()
  const answered: { requestId: string } = await client.respondPermission('request-1', {
    optionId: 'allow'
  })
  const replayed: ReplayVersionReport = await client.replayVersion({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'version-1'
  })
  const exported: Response = await client.downloadSessionPackage('session-1', { mode: 'full' })
  const imported: SessionPackageImport = await client.importSessionPackage(new Uint8Array([1]))

  void [
    readiness,
    runtimes,
    connectors,
    capabilities,
    scoped,
    pending,
    answered,
    replayed,
    exported
  ]
  void imported
}

describe('published declaration surface', () => {
  it('declares every method the runtime ships, minus the named transport internals', async () => {
    const declared = (await declaredMethodNames()).sort()
    const runtime = runtimeMethodNames().sort()
    const expected = runtime.filter((name) => !INTERNAL_METHODS.includes(name))
    expect(declared).toEqual(expected)
    expect(runtime.filter((name) => !declared.includes(name))).toEqual(INTERNAL_METHODS)
  })

  it('keeps the typed consumer callable for every declared method', () => {
    // The assertion is the file compiling: `typecheck:node` covers packages/**/*.
    expect(typeof typedConsumer).toBe('function')
  })
})
