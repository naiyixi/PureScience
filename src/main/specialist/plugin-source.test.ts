import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
  parsePluginSourceReference,
  pluginSourceManifestUrls
} from '../../shared/plugin-source'
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
