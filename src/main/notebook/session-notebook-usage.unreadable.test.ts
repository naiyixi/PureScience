import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// A directory that exists but cannot be listed cannot be staged portably: a runner that happens to be root
// walks straight through a permission bit. So the failure is injected at the walker boundary, and what this
// file asserts is the REPORTING the read owes the confirmation: "could not be measured", never "nothing
// there". The two states print different sentences, and the second one is a claim we cannot make.
vi.mock('../storage/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/usage')>()),
  measureDirectorySize: vi.fn(async () => ({ state: 'unavailable', reason: 'unreadable' }))
}))

import { measureSessionNotebookData } from './session-data-cleanup'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'notebook-session-usage-unreadable-'))
  await mkdir(
    join(root, 'notebooks', 'cmutflcqb000fwfm931kvwz21', '9f1c2f4a-1111-4a2b-8c3d-000000000008'),
    {
      recursive: true
    }
  )
  await writeFile(
    join(
      root,
      'notebooks',
      'cmutflcqb000fwfm931kvwz21',
      '9f1c2f4a-1111-4a2b-8c3d-000000000008',
      'results.h5ad'
    ),
    Buffer.alloc(64, 3)
  )
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('a session directory that cannot be read', () => {
  it('reports that it could not be measured instead of zero bytes', async () => {
    const usage = await measureSessionNotebookData(
      { dataRoot: root },
      'cmutflcqb000fwfm931kvwz21',
      '9f1c2f4a-1111-4a2b-8c3d-000000000008'
    )

    expect(usage).toEqual({ state: 'unavailable', reason: 'unreadable' })
    // "Zero bytes" and "could not look" must not be the same value: the surface prints a figure for the
    // first and a sentence about not knowing for the second.
    expect(usage).not.toEqual({ state: 'measured', bytes: 0 })
  })
})
