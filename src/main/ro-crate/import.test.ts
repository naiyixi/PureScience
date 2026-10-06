import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { inspectExternalRoCrate, RO_CRATE_METADATA_FILENAME } from './import'

const crateWith = async (contents: string | null): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'external-crate-'))
  if (contents !== null) {
    await writeFile(join(dir, RO_CRATE_METADATA_FILENAME), contents, 'utf8')
  }
  return dir
}

describe('inspectExternalRoCrate', () => {
  it('reports the app’s own rules on a crate whose metadata parses', async () => {
    // A minimal graph that satisfies the shape rule and nothing else: the report is where the failing
    // assertions live, so this must come back as a report rather than a refusal.
    const cratePath = await crateWith(
      JSON.stringify({
        '@context': 'https://w3id.org/ro/crate/1.1/context',
        '@graph': [
          {
            '@id': 'ro-crate-metadata.json',
            '@type': 'CreativeWork',
            about: { '@id': './' }
          },
          { '@id': './', '@type': 'Dataset', name: 'External crate' }
        ]
      })
    )

    const result = await inspectExternalRoCrate(cratePath)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metadataPath).toBe(join(cratePath, RO_CRATE_METADATA_FILENAME))
    // The report carries every assertion, passed or failed — this module does not summarise them away.
    expect(result.report.assertions.length).toBeGreaterThan(0)
    expect(result.report.passed + result.report.failed).toBe(result.report.assertions.length)
  })

  it('names a missing metadata document instead of reporting rules it never read', async () => {
    const cratePath = await crateWith(null)

    expect(await inspectExternalRoCrate(cratePath)).toEqual({
      ok: false,
      reason: 'no-metadata-file',
      detail: `${join(cratePath, RO_CRATE_METADATA_FILENAME)} does not exist`
    })
  })

  it('names an unparseable document rather than judging it', async () => {
    const cratePath = await crateWith('{ not json')

    const result = await inspectExternalRoCrate(cratePath)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unparseable')
    expect(result.detail).toContain(cratePath)
  })

  it('keeps “not a crate” apart from “cannot be read right now”', async () => {
    // A directory where the metadata document should be: the read fails, but not because it is absent.
    const cratePath = await mkdtemp(join(tmpdir(), 'external-crate-'))
    await mkdir(join(cratePath, RO_CRATE_METADATA_FILENAME))

    const result = await inspectExternalRoCrate(cratePath)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unreadable')
  })
})
