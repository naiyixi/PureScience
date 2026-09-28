import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import * as tar from 'tar'

import {
  createSupportBundle,
  listSupportBundleEntries,
  type SupportBundleInput
} from './support-bundle'

const roots: string[] = []

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'support-bundle-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const HOME_DIR = '/Users/example-user'

const baseInput = async (root: string): Promise<SupportBundleInput> => {
  await mkdir(join(root, 'logs'), { recursive: true })
  await mkdir(join(root, 'out'), { recursive: true })
  return {
    logDir: join(root, 'logs'),
    outPath: join(root, 'out', 'purescience-support.tar.gz'),
    versions: { app: '1.75.0', electron: '43.7.5', chrome: '140.0.0.0', node: '22.22.3' },
    platform: 'darwin',
    arch: 'arm64',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    packaged: true,
    storageLocation: 'custom',
    homeDir: HOME_DIR,
    userName: 'example-user',
    now: () => new Date('2026-09-28T00:00:00.000Z')
  }
}

const extractTo = async (bundlePath: string, target: string): Promise<void> => {
  await mkdir(target, { recursive: true })
  await tar.extract({ file: bundlePath, cwd: target })
}

const readFrom = async (target: string, relative: string): Promise<string> =>
  readFile(join(target, relative), 'utf8')

describe('support bundle', () => {
  it('writes the manifest, environment, runtime summary, readme and logs', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    await writeFile(join(root, 'logs', 'purescience.log'), 'boot ok\n', 'utf8')

    const result = await createSupportBundle(input)

    expect(result.entries).toEqual(
      expect.arrayContaining(['manifest.json', 'environment.json', 'runtime.json', 'README.txt'])
    )
    expect(result.entries).toContain('logs/purescience.log')
    expect(result.bytes).toBeGreaterThan(0)

    const target = join(root, 'extracted')
    await extractTo(result.path, target)
    const manifest = JSON.parse(await readFrom(target, 'manifest.json'))
    expect(manifest).toMatchObject({
      generatedAt: '2026-09-28T00:00:00.000Z',
      application: '1.75.0',
      electron: '43.7.5',
      node: '22.22.3',
      platform: 'darwin',
      arch: 'arm64',
      timezone: 'Asia/Shanghai'
    })
  })

  it('carries the storage location class but never a path', async () => {
    const root = await createRoot()
    const input = await baseInput(root)

    const result = await createSupportBundle(input)
    const target = join(root, 'extracted')
    await extractTo(result.path, target)

    const runtime = await readFrom(target, 'runtime.json')
    expect(JSON.parse(runtime)).toMatchObject({ storageLocation: 'custom' })
    expect(runtime).not.toContain(HOME_DIR)
    expect(runtime).not.toContain('/')
  })

  it('scrubs the home directory, the user name and secret-shaped values out of copied logs', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    await writeFile(
      join(root, 'logs', 'purescience.log'),
      [
        `opened ${HOME_DIR}/work/project`,
        'stack at example-user/Library/Application Support',
        'provider api_key = "abcdef123456"',
        'Authorization: Bearer ghu_1234567890abcdef'
      ].join('\n'),
      'utf8'
    )

    const result = await createSupportBundle(input)
    expect(result.redactions).toBeGreaterThanOrEqual(3)

    const target = join(root, 'extracted')
    await extractTo(result.path, target)
    const log = await readFrom(target, 'logs/purescience.log')
    expect(log).not.toContain(HOME_DIR)
    expect(log).not.toContain('example-user')
    expect(log).not.toContain('abcdef123456')
    expect(log).not.toContain('ghu_1234567890abcdef')
    expect(log).toContain('<path>')
    expect(log).toContain('[REDACTED]')
  })

  it('refuses to produce a bundle when a leak survives scrubbing', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    await writeFile(join(root, 'logs', 'purescience.log'), `secret at ${HOME_DIR}\n`, 'utf8')

    // The scrubbing pass is disabled on purpose: the read-back check must still catch what would ship.
    await expect(createSupportBundle({ ...input, scrub: false })).rejects.toThrow(
      /Support bundle aborted/
    )
    await expect(stat(input.outPath)).rejects.toThrow()
  })

  it('copies the newest logs first and stops at the byte cap', async () => {
    const root = await createRoot()
    const input = await baseInput(root)
    await writeFile(join(root, 'logs', 'purescience.1.log'), 'old'.repeat(200), 'utf8')
    await writeFile(join(root, 'logs', 'purescience.log'), 'new'.repeat(200), 'utf8')

    // One log fits the cap, not two.
    const result = await createSupportBundle({ ...input, maxLogBytes: 700 })

    expect(result.entries).toContain('logs/purescience.log')
    expect(result.entries).not.toContain('logs/purescience.1.log')
  })

  it('lists the entries of a written bundle without extracting it', async () => {
    const root = await createRoot()
    const input = await baseInput(root)

    const result = await createSupportBundle(input)
    await expect(listSupportBundleEntries(result.path)).resolves.toEqual(
      expect.arrayContaining(['manifest.json', 'README.txt'])
    )
  })
})
