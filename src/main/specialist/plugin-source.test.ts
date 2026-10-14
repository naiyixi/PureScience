import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
  parsePluginSourceReference,
  pluginSourceManifestUrls
} from '../../shared/plugin-source'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginSourceCandidateStore } from './plugin-source-candidate'
import { deployPlugin, readDeployedPlugin } from './plugin-deploy'
import { decidePluginOperation, PLUGIN_OPERATION_RULE } from './plugin-run-policy'
import { previewPluginSource, type PluginFetchOutcome } from './plugin-source'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const manifestBytes = (overrides: Record<string, unknown> = {}): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      schema_version: 1,
      id: 'demo-plugin',
      display_name: 'Demo plugin',
      summary: 'A plugin used by the tests.',
      license: 'MIT',
      runtime: { kind: 'node' },
      tools: [{ name: 'demo_tool', description: 'Does the demo thing.', entry: 'tools/demo.mjs' }],
      ...overrides
    })
  )

const ok = (bytes: Uint8Array): PluginFetchOutcome => ({ ok: true, bytes })
const status = (code: number): PluginFetchOutcome => ({ ok: false, status: code })

describe('plugin source reference', () => {
  it('accepts the explicit host forms and refuses to guess one', () => {
    expect(parsePluginSourceReference('github:acme/plugin')).toMatchObject({
      state: 'available',
      ref: { owner: 'acme', repo: 'plugin', ref: 'HEAD', path: PLUGIN_MANIFEST_FILENAME }
    })
    // A real GitHub URL does not carry the ref as a @suffix (only the short form does): the .git suffix is
    // stripped, and a ref travels in a /tree/ or /blob/ segment.
    expect(parsePluginSourceReference('https://github.com/acme/plugin.git')).toMatchObject({
      state: 'available',
      ref: { owner: 'acme', repo: 'plugin', ref: 'HEAD' }
    })
    // A browser link carries the ref in a segment; it is taken out rather than treated as a path.
    expect(parsePluginSourceReference('https://github.com/acme/plugin/tree/v2')).toMatchObject({
      state: 'available',
      ref: { ref: 'v2', path: PLUGIN_MANIFEST_FILENAME }
    })
    // An explicit .json path is the manifest itself (a repository may keep it under another name).
    expect(parsePluginSourceReference('github:acme/plugin@main/dist/other.json')).toMatchObject({
      state: 'available',
      ref: { path: 'dist/other.json' }
    })

    for (const input of [
      '',
      'acme/plugin',
      'http://github.com/acme/plugin',
      'https://gitlab.com/acme/plugin',
      'https://github.com/acme',
      'https://github.com/acme/plugin?x=1',
      'github:acme/../plugin'
    ]) {
      expect(parsePluginSourceReference(input), input).toMatchObject({
        state: 'unavailable',
        reason: 'invalid-reference'
      })
    }
  })

  it('builds every manifest URL from the reference alone', () => {
    const parsed = parsePluginSourceReference('github:acme/plugin@v1')
    if (parsed.state !== 'available') throw new Error('expected a parsed reference')
    const urls = pluginSourceManifestUrls(parsed.ref)
    expect(urls).toHaveLength(2)
    for (const url of urls) {
      expect(url).toContain('acme/plugin')
      expect(url).toContain('v1')
      expect(url).toContain(PLUGIN_MANIFEST_FILENAME)
    }
  })
})

describe('plugin manifest', () => {
  it('accepts a declaration and names every issue of one that does not fit', () => {
    const good = parsePluginManifest(manifestBytes())
    expect(good.state).toBe('available')

    const unknownKey = parsePluginManifest(manifestBytes({ extra: true }))
    if (unknownKey.state !== 'unavailable') throw new Error('expected a refusal')
    expect(unknownKey.issues.join(' ')).toContain('extra')

    const noTools = parsePluginManifest(manifestBytes({ tools: [] }))
    if (noTools.state !== 'unavailable') throw new Error('expected a refusal')
    expect(noTools.issues.join(' ')).toContain('tools')

    const badRuntime = parsePluginManifest(manifestBytes({ runtime: { kind: 'ruby' } }))
    if (badRuntime.state !== 'unavailable') throw new Error('expected a refusal')
    expect(badRuntime.issues.join(' ')).toContain('runtime.kind')

    const notJson = parsePluginManifest(new TextEncoder().encode('not json at all'))
    if (notJson.state !== 'unavailable') throw new Error('expected a refusal')
    expect(notJson.issues[0]).toContain('not JSON')
  })
})

describe('plugin source preview', () => {
  it('reports the fetched bytes own digest and size, and writes nothing', async () => {
    const bytes = manifestBytes()
    const fetchBytes = vi.fn().mockResolvedValue(ok(bytes))
    const preview = await previewPluginSource('github:acme/plugin@v1', { fetchBytes })

    expect(fetchBytes).toHaveBeenCalledTimes(1)
    if (preview.state !== 'available') throw new Error('expected an available preview')
    expect(preview.source).toMatchObject({ owner: 'acme', repo: 'plugin', ref: 'v1' })
    expect(preview.manifest.tools[0].name).toBe('demo_tool')
    // The reading is recomputable: this test computes the digest itself from the same bytes.
    expect(preview.fetched.bytes).toBe(bytes.byteLength)
    expect(preview.fetched.sha256).toBe(sha256(bytes))
  })

  it('tries the next mirror when a host answers 404, and names what every host said when none has it', async () => {
    const bytes = manifestBytes()
    const fetchBytes = vi.fn().mockResolvedValueOnce(status(404)).mockResolvedValueOnce(ok(bytes))
    const preview = await previewPluginSource('github:acme/plugin', { fetchBytes })
    expect(preview.state).toBe('available')

    const bothMissing = vi.fn().mockResolvedValue(status(404))
    const missing = await previewPluginSource('github:acme/plugin', { fetchBytes: bothMissing })
    expect(missing).toMatchObject({ state: 'unavailable', reason: 'manifest-missing' })
    if (missing.state !== 'unavailable') throw new Error('expected a refusal')
    expect(missing.detail).toContain('404')

    const hostDown = vi.fn().mockResolvedValue(status(503))
    const unreachable = await previewPluginSource('github:acme/plugin', { fetchBytes: hostDown })
    expect(unreachable).toMatchObject({ state: 'unavailable', reason: 'source-unreachable' })
    if (unreachable.state !== 'unavailable') throw new Error('expected a refusal')
    expect(unreachable.detail).toContain('503')
  })

  it('surfaces a declaration that does not fit, and refuses a bad reference without any request', async () => {
    const fetchBytes = vi.fn().mockResolvedValue(ok(new TextEncoder().encode('{}')))
    const invalid = await previewPluginSource('github:acme/plugin', { fetchBytes })
    expect(invalid).toMatchObject({ state: 'unavailable', reason: 'manifest-invalid' })
    if (invalid.state !== 'unavailable') throw new Error('expected a refusal')
    expect(invalid.issues?.join(' ')).toContain('schema_version')

    const never = vi.fn()
    const refused = await previewPluginSource('acme/plugin', { fetchBytes: never })
    expect(refused).toMatchObject({ state: 'unavailable', reason: 'invalid-reference' })
    expect(never).not.toHaveBeenCalled()
  })

  it('carries the fetched digest even when the content is refused', async () => {
    // The red line this slice exists for: a reader checks what ARRIVED, most of all when the declaration
    // does not fit. So the refusal carries the bytes' own digest and size, recomputable by the reader.
    const bytes = new TextEncoder().encode('{"schema_version":2}')
    const fetchBytes = vi.fn().mockResolvedValue(ok(bytes))
    const preview = await previewPluginSource('github:acme/plugin', { fetchBytes })
    expect(preview).toMatchObject({ state: 'unavailable', reason: 'manifest-invalid' })
    if (preview.state !== 'unavailable') throw new Error('expected a refusal')
    expect(preview.fetched).toEqual({ bytes: bytes.byteLength, sha256: sha256(bytes) })
  })
})

describe('plugin source candidate', () => {
  const manifestBytes = (): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        id: 'demo-plugin',
        display_name: 'Demo plugin',
        summary: 'A plugin used by the tests.',
        license: 'MIT',
        runtime: { kind: 'node' },
        tools: [{ name: 'demo_tool', description: 'Does the demo thing.', entry: 'tools/demo.mjs' }]
      })
    )

  it('issues a token for what was read, binds it to the owner, and refuses a token it never issued', async () => {
    const store = new PluginSourceCandidateStore({
      fetchBytes: async () => ({ ok: true, bytes: manifestBytes() })
    })
    const candidate = await store.preview('github:acme/plugin', 'owner-1')
    expect(candidate.state).toBe('available')
    expect(candidate.candidateToken).not.toBe('')
    expect(candidate.declaration).toEqual({ state: 'ok' })

    const taken = store.take(candidate.candidateToken, 'owner-1')
    expect(taken.state).toBe('ok')
    // Another owner cannot act on it, and a token nobody issued is refused rather than guessed at.
    expect(store.take(candidate.candidateToken, 'owner-2')).toEqual({
      state: 'refused',
      reason: 'unknown-token'
    })
    expect(store.take('not-issued-by-us', 'owner-1')).toEqual({
      state: 'refused',
      reason: 'unknown-token'
    })
  })

  it('expires a token instead of honouring an old approval', async () => {
    let clock = 1_000
    const store = new PluginSourceCandidateStore({
      fetchBytes: async () => ({ ok: true, bytes: manifestBytes() }),
      now: () => clock,
      ttlMs: 60_000
    })
    const candidate = await store.preview('github:acme/plugin', 'owner-1')
    clock += 61_000
    expect(store.take(candidate.candidateToken, 'owner-1')).toEqual({
      state: 'refused',
      reason: 'token-expired'
    })
  })

  it('issues no token for a preview that could not be read, and counts what a disposal dropped', async () => {
    const store = new PluginSourceCandidateStore({
      fetchBytes: async () => ({ ok: false, status: 404 })
    })
    const refused = await store.preview('github:acme/plugin', 'owner-1')
    expect(refused.state).toBe('unavailable')
    expect(store.take(refused.candidateToken, 'owner-1')).toEqual({
      state: 'refused',
      reason: 'unknown-token'
    })

    const good = new PluginSourceCandidateStore({
      fetchBytes: async () => ({ ok: true, bytes: manifestBytes() })
    })
    await good.preview('github:acme/plugin', 'owner-1')
    await good.preview('github:acme/plugin', 'owner-1')
    expect(good.dispose('owner-1')).toBe(2)
    expect(good.dispose('owner-1')).toBe(0)
  })

  it('refuses a declaration the app cannot honour, before anything could run', async () => {
    const unsafe = new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        id: 'demo-plugin',
        display_name: 'Demo plugin',
        summary: 'A plugin used by the tests.',
        license: 'MIT',
        runtime: { kind: 'node' },
        tools: [{ name: 'demo_tool', description: 'Does the demo thing.', entry: '../outside.mjs' }]
      })
    )
    const store = new PluginSourceCandidateStore({
      fetchBytes: async () => ({ ok: true, bytes: unsafe })
    })
    const candidate = await store.preview('github:acme/plugin', 'owner-1')
    expect(candidate.declaration).toMatchObject({ state: 'refused', reason: 'entry-unsafe' })
    if (candidate.declaration.state !== 'refused') throw new Error('expected a refusal')
    expect(candidate.declaration.detail).toContain('tools.demo_tool.entry')
  })
})

describe('plugin deploy', () => {
  const manifest = {
    schema_version: 1 as const,
    id: 'demo-plugin',
    display_name: 'Demo plugin',
    summary: 'A plugin used by the tests.',
    license: 'MIT',
    runtime: { kind: 'node' as const },
    tools: [
      { name: 'demo_tool', description: 'Does the demo thing.', entry: 'tools/demo.mjs' },
      { name: 'second_tool', description: 'Does the other thing.', entry: 'tools/second.mjs' }
    ]
  }

  const bytesFor = (entry: string): Uint8Array => new TextEncoder().encode(`// ${entry}\n`)

  it('writes the declared entries atomically and records the digest of the bytes it wrote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-deploy-'))
    const result = await deployPlugin({
      manifest,
      pluginsRoot: root,
      readEntry: async (entry) => bytesFor(entry)
    })

    if (result.state !== 'deployed')
      throw new Error(`expected a deployment, got ${JSON.stringify(result)}`)
    expect(result.entries.map((entry) => entry.entry)).toEqual([
      'tools/demo.mjs',
      'tools/second.mjs'
    ])
    // The digest is recomputed here from the same bytes, so the module cannot invent one.
    for (const entry of result.entries) {
      expect(entry.sha256).toBe(sha256(bytesFor(entry.entry)))
      expect(entry.bytes).toBe(bytesFor(entry.entry).byteLength)
    }
    expect(await readdir(root)).toEqual(['demo-plugin'])
    // The journal and the files are really there, and the staging directory is not.
    const deployed = await readDeployedPlugin(root, 'demo-plugin')
    expect(deployed?.entries).toHaveLength(2)
    await rm(root, { recursive: true, force: true })
  })

  it('leaves NOTHING behind when one declared entry is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-deploy-'))
    const result = await deployPlugin({
      manifest,
      pluginsRoot: root,
      readEntry: async (entry) => (entry === 'tools/second.mjs' ? null : bytesFor(entry))
    })

    expect(result).toMatchObject({ state: 'refused', reason: 'entry-missing' })
    // The red line: a failed deployment is not a partial one — the plugin directory does not exist.
    expect(await readdir(root)).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('rolls back a write failure, and refuses to replace a plugin that is already deployed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-deploy-'))
    const failing = await deployPlugin({
      manifest,
      pluginsRoot: root,
      readEntry: async () => {
        throw new Error('the source stopped answering')
      }
    })
    expect(failing).toMatchObject({ state: 'refused', reason: 'deploy-failed' })
    expect(await readdir(root)).toEqual([])

    await deployPlugin({ manifest, pluginsRoot: root, readEntry: async (entry) => bytesFor(entry) })
    const again = await deployPlugin({
      manifest,
      pluginsRoot: root,
      readEntry: async (entry) => bytesFor(entry)
    })
    expect(again).toMatchObject({ state: 'refused', reason: 'already-deployed' })
    expect(await readdir(root)).toEqual(['demo-plugin'])
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a declaration the app cannot honour before writing anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-deploy-'))
    const result = await deployPlugin({
      manifest: {
        ...manifest,
        tools: [{ name: 'demo_tool', description: 'x', entry: '../outside.mjs' }]
      },
      pluginsRoot: root,
      readEntry: async (entry) => bytesFor(entry)
    })
    expect(result).toMatchObject({ state: 'refused', reason: 'declaration-refused' })
    expect(await readdir(root)).toEqual([])
    await rm(root, { recursive: true, force: true })
  })
})

describe('plugin operation gate', () => {
  type Protection = Parameters<typeof decidePluginOperation>[0]['protection']
  const protection = (
    level: 'protected' | 'unprotected',
    scope: { filesystem: string; network: string } = {
      filesystem: 'runtime-write-protected',
      network: 'allowlist'
    }
  ): Protection => ({ level, scope }) as unknown as Protection

  it('refuses anything that was not confirmed, and says what the operation would do', () => {
    for (const operation of ['deploy', 'run-once'] as const) {
      const decision = decidePluginOperation({
        operation,
        confirmed: false,
        protection: protection('protected'),
        policy: 'remembered'
      })
      expect(decision).toMatchObject({ state: 'refused', reason: 'confirmation-missing' })
      if (decision.state !== 'refused') throw new Error('expected a refusal')
      expect(decision.detail).toContain(PLUGIN_OPERATION_RULE[operation])
    }
  })

  it('lets a confirmed deploy write files, and says running is a separate decision', () => {
    const decision = decidePluginOperation({
      operation: 'deploy',
      confirmed: true,
      protection: protection('unprotected'),
      policy: 'deny'
    })
    expect(decision).toMatchObject({ state: 'allowed' })
    if (decision.state !== 'allowed') throw new Error('expected an allowance')
    expect(decision.detail).toContain('separate decision')
  })

  it('consults the app policy for a run: deny means deny, and unprotected-without-remembering needs an approval', () => {
    const denied = decidePluginOperation({
      operation: 'run-once',
      confirmed: true,
      protection: protection('unprotected'),
      policy: 'deny'
    })
    expect(denied).toMatchObject({ state: 'refused', reason: 'unprotected-execution-denied' })
    if (denied.state !== 'refused') throw new Error('expected a refusal')
    // The refusal names the axes, not just the verdict.
    expect(denied.detail).toContain('allowlist')

    const needsApproval = decidePluginOperation({
      operation: 'run-once',
      confirmed: true,
      protection: protection('unprotected'),
      policy: 'confirm'
    })
    expect(needsApproval).toMatchObject({ state: 'refused', reason: 'approval-required' })

    const remembered = decidePluginOperation({
      operation: 'run-once',
      confirmed: true,
      protection: protection('unprotected'),
      policy: 'remembered'
    })
    expect(remembered).toMatchObject({ state: 'allowed' })

    const protectedRun = decidePluginOperation({
      operation: 'run-once',
      confirmed: true,
      protection: protection('protected'),
      policy: 'confirm'
    })
    expect(protectedRun).toMatchObject({ state: 'allowed' })
  })
})
