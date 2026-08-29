import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FolderGrantsService } from './folder-grants'

let dir: string
let service: FolderGrantsService

beforeEach(async () => {
  // Use the home directory (not /var/folders tmp): grant validation rejects sensitive/system roots.
  dir = await mkdtemp(join(homedir(), '.folder-grants-test-'))
  console.log('DEBUG test dir:', dir)
  service = new FolderGrantsService({ dataRoot: dir })
})

afterEach(async () => {
  await service.shutdown()
  await rm(dir, { recursive: true, force: true })
})

describe('FolderGrantsService', () => {
  it('grants a directory and persists it across instances', async () => {
    const grant = await service.grant(join(dir, 'data'))
    expect(grant.label).toBe('data')
    expect(grant.rootPath).toBe(join(dir, 'data'))

    await service.shutdown() // flush the async persistence chain
    const reloaded = new FolderGrantsService({ dataRoot: dir })
    const snapshot = await reloaded.list()
    expect(snapshot.grants).toHaveLength(1)
    expect(snapshot.grants[0].rootId).toBe(grant.rootId)
    await reloaded.shutdown()
  })

  it('returns the existing grant for the same path', async () => {
    const first = await service.grant(join(dir, 'data'))
    const second = await service.grant(join(dir, 'data'))
    expect(second.rootId).toBe(first.rootId)
    expect((await service.list()).grants).toHaveLength(1)
  })

  it('rejects sensitive roots', async () => {
    await expect(service.grant(join(homedir(), '.ssh'))).rejects.toThrow(/not grantable/)
  })

  it('resolves a granted root and fails closed after revoke', async () => {
    const grant = await service.grant(join(dir, 'data'))
    expect(await service.resolveRoot(grant.rootId)).toBe(join(dir, 'data'))
    expect(await service.revoke(grant.rootId)).toBe(true)
    expect(await service.resolveRoot(grant.rootId)).toBeUndefined()
    expect((await service.list()).grants).toHaveLength(0)
  })

  it('ignores corrupt grant files (fail closed)', async () => {
    await writeFile(join(dir, 'folder-grants.json'), '{not-json', 'utf8')
    const broken = new FolderGrantsService({ dataRoot: dir })
    expect((await broken.list()).grants).toHaveLength(0)
    await broken.shutdown()
  })

  it('persists grants as a bounded JSON snapshot', async () => {
    await service.grant(join(dir, 'a'))
    await service.grant(join(dir, 'b'))
    await service.shutdown() // flush the async persistence chain
    const raw = await readFile(join(dir, 'folder-grants.json'), 'utf8')
    const parsed = JSON.parse(raw) as { grants: unknown[] }
    expect(parsed.grants).toHaveLength(2)
  })
})
