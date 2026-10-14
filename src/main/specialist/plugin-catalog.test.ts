import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { PluginManifest } from '../../shared/plugin-source'
import {
  DEPLOYED_RECORD_FILENAME,
  listDeployedPlugins,
  removeDeployedPlugin
} from './plugin-catalog'
import { deployPlugin } from './plugin-deploy'

// The catalogue is the read side of the deployer, so these cases deploy for real (the same `deployPlugin`
// the app calls) and then read what is on disk. Nothing is mocked: what the row reports is compared with a
// digest and a size the test computes itself, which is the only way to tell "reported the record" from
// "invented a number".

const roots: string[] = []

const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ps-plugin-catalog-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const manifest = (overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  schema_version: 1,
  id: 'demo-plugin',
  display_name: 'Demo plugin',
  summary: 'A plugin used by the tests.',
  license: 'MIT',
  runtime: { kind: 'node' },
  tools: [{ name: 'demo_tool', description: 'Does the demo thing.', entry: 'tools/demo.mjs' }],
  ...overrides
})

/** A real deployment, through the same module the app uses. */
const deploy = async (
  root: string,
  bytes: Uint8Array,
  overrides: Partial<PluginManifest> = {}
): Promise<void> => {
  const result = await deployPlugin({
    manifest: manifest(overrides),
    pluginsRoot: root,
    readEntry: async () => bytes
  })
  if (result.state !== 'deployed') throw new Error(`deployment failed: ${result.detail}`)
}

/** The test's own size recipe: walk the directory and add up what is really there. */
const walkBytes = async (directory: string): Promise<number> => {
  let total = 0
  for (const dirent of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, dirent.name)
    if (dirent.isDirectory()) total += await walkBytes(child)
    else total += (await stat(child)).size
  }
  return total
}

describe('deployed plugin catalogue', () => {
  it('reports a real deployment from its own record, with a size measured on disk', async () => {
    const root = await newRoot()
    const bytes = new TextEncoder().encode('console.log("demo")\n')
    await deploy(root, bytes)

    const rows = await listDeployedPlugins({ pluginsRoot: root })

    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.state).toBe('deployed')
    if (row.state !== 'deployed') return
    expect(row.pluginId).toBe('demo-plugin')
    // The digest is the one of the bytes that were written — recomputed here, not read back from the row.
    expect(row.entries).toEqual([
      { entry: 'tools/demo.mjs', bytes: bytes.byteLength, sha256: sha256(bytes) }
    ])
    // The size includes the record itself, and it is the directory's real size: compared against this
    // test's own walk rather than against the module's own measurement helper.
    expect(row.onDiskBytes).toBe(await walkBytes(join(root, 'demo-plugin')))
    expect(row.onDiskBytes).toBeGreaterThan(bytes.byteLength)
    expect(typeof row.deployedAt).toBe('string')
  })

  it('names a directory with no record instead of skipping it or showing an empty plugin', async () => {
    const root = await newRoot()
    await mkdir(join(root, 'someone-elses-directory'), { recursive: true })

    const rows = await listDeployedPlugins({ pluginsRoot: root })

    expect(rows).toEqual([
      {
        state: 'record-missing',
        pluginId: 'someone-elses-directory',
        directory: join(root, 'someone-elses-directory'),
        onDiskBytes: 0
      }
    ])
  })

  it('separates a record that cannot be read from a record that is not there', async () => {
    const root = await newRoot()
    await mkdir(join(root, 'broken-plugin'), { recursive: true })
    await writeFile(join(root, 'broken-plugin', DEPLOYED_RECORD_FILENAME), '{ not json', 'utf8')

    const [row] = await listDeployedPlugins({ pluginsRoot: root })

    expect(row.state).toBe('record-unreadable')
    if (row.state !== 'record-unreadable') return
    expect(row.pluginId).toBe('broken-plugin')
    expect(row.detail).toContain('not JSON')
  })

  it('does not show the deploy path’s own staging directory as a plugin', async () => {
    const root = await newRoot()
    await deploy(root, new TextEncoder().encode('x'))
    await mkdir(join(root, '.staging-demo-plugin-1234abcd'), { recursive: true })

    const rows = await listDeployedPlugins({ pluginsRoot: root })

    expect(rows.map((row) => row.pluginId)).toEqual(['demo-plugin'])
  })

  it('lists several plugins in a stable order', async () => {
    const root = await newRoot()
    await deploy(root, new TextEncoder().encode('a'), { id: 'zeta-plugin' })
    await deploy(root, new TextEncoder().encode('b'), { id: 'alpha-plugin' })

    const rows = await listDeployedPlugins({ pluginsRoot: root })

    expect(rows.map((row) => row.pluginId)).toEqual(['alpha-plugin', 'zeta-plugin'])
  })

  it('reports a missing root as an empty listing rather than throwing', async () => {
    const root = await newRoot()
    expect(await listDeployedPlugins({ pluginsRoot: join(root, 'never-created') })).toEqual([])
  })
})

describe('deployed plugin removal', () => {
  it('removes a deployed plugin and reports the bytes it freed', async () => {
    const root = await newRoot()
    await deploy(root, new TextEncoder().encode('console.log("demo")\n'))
    const before = await walkBytes(join(root, 'demo-plugin'))

    const removal = await removeDeployedPlugin(
      { pluginsRoot: root },
      { pluginId: 'demo-plugin', confirmed: true }
    )

    expect(removal).toEqual({ state: 'removed', pluginId: 'demo-plugin', freedBytes: before })
    await expect(stat(join(root, 'demo-plugin'))).rejects.toThrow()
    expect(await listDeployedPlugins({ pluginsRoot: root })).toEqual([])
  })

  it('refuses without the confirmation, and leaves the plugin exactly where it was', async () => {
    const root = await newRoot()
    await deploy(root, new TextEncoder().encode('x'))

    const removal = await removeDeployedPlugin(
      { pluginsRoot: root },
      { pluginId: 'demo-plugin', confirmed: false }
    )

    expect(removal).toMatchObject({
      state: 'refused',
      reason: 'confirmation-missing',
      freedBytes: 0
    })
    // "Refused" has to mean nothing happened: the directory is still there.
    expect((await stat(join(root, 'demo-plugin'))).isDirectory()).toBe(true)
  })

  it('refuses an id that is not a plugin id before anything is joined to a path', async () => {
    const root = await newRoot()
    const pluginsRoot = join(root, 'plugins')
    const outside = join(root, 'not-touched')
    await mkdir(pluginsRoot, { recursive: true })
    await mkdir(outside, { recursive: true })

    // `../not-touched` resolves to a real directory next to the plugins root: the point of the check is that
    // this name never reaches a path join, so the directory survives every one of these calls.
    for (const pluginId of ['../not-touched', 'Demo-Plugin', '', '.hidden']) {
      const removal = await removeDeployedPlugin({ pluginsRoot }, { pluginId, confirmed: true })
      expect(removal).toMatchObject({ state: 'refused', reason: 'unsafe-plugin-id', freedBytes: 0 })
    }
    expect((await stat(outside)).isDirectory()).toBe(true)
  })

  it('reports a name that is not there as absent, not as a refusal and not as zero bytes freed', async () => {
    const root = await newRoot()

    const removal = await removeDeployedPlugin(
      { pluginsRoot: root },
      { pluginId: 'never-deployed', confirmed: true }
    )

    expect(removal).toEqual({ state: 'absent', pluginId: 'never-deployed' })
  })

  it('refuses a directory this app did not deploy, and leaves it in place', async () => {
    const root = await newRoot()
    await mkdir(join(root, 'not-ours'), { recursive: true })
    await writeFile(join(root, 'not-ours', 'notes.txt'), 'mine', 'utf8')

    const removal = await removeDeployedPlugin(
      { pluginsRoot: root },
      { pluginId: 'not-ours', confirmed: true }
    )

    expect(removal).toMatchObject({
      state: 'refused',
      reason: 'not-a-deployed-plugin',
      freedBytes: 0
    })
    if (removal.state !== 'refused') return
    expect(removal.detail).toContain(DEPLOYED_RECORD_FILENAME)
    expect((await stat(join(root, 'not-ours', 'notes.txt'))).size).toBe(4)
  })

  it('refuses a directory whose record cannot be read, rather than guessing it was ours', async () => {
    const root = await newRoot()
    await mkdir(join(root, 'broken-plugin'), { recursive: true })
    await writeFile(join(root, 'broken-plugin', DEPLOYED_RECORD_FILENAME), '{}', 'utf8')

    const removal = await removeDeployedPlugin(
      { pluginsRoot: root },
      { pluginId: 'broken-plugin', confirmed: true }
    )

    expect(removal).toMatchObject({
      state: 'refused',
      reason: 'not-a-deployed-plugin',
      freedBytes: 0
    })
    if (removal.state !== 'refused') return
    expect(removal.detail).toContain('does not list entries')
    expect((await stat(join(root, 'broken-plugin'))).isDirectory()).toBe(true)
  })

  it('refuses a plugin whose name is not a directory', async () => {
    const root = await newRoot()
    await writeFile(join(root, 'a-file'), 'x', 'utf8')

    const removal = await removeDeployedPlugin(
      { pluginsRoot: root },
      { pluginId: 'a-file', confirmed: true }
    )

    expect(removal).toMatchObject({
      state: 'refused',
      reason: 'not-a-deployed-plugin',
      freedBytes: 0
    })
  })
})
