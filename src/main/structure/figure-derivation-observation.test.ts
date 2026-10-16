import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  figureDerivationFingerprint,
  readSessionStructureObservations,
  recordStructureObservation
} from './structure-observation-journal'

// U4-d：插图派生结果落在**既有**那条溯源面上（第三种 kind），并且带上可由外部复算的输入指纹。
const figureInput = {
  page: 2,
  bbox: { x: 100, y: 300, width: 300, height: 200 },
  caption: 'Figure 9. Dose-response curves; error bars show SEM; n = 6.',
  inFigureText: ['0.83', 'p<0.001']
}

describe('structure observations 上的插图派生（U4-d）', () => {
  it('把一条派生记录round-trip，并带着它的输入指纹', async () => {
    const root = mkdtempSync(join(tmpdir(), 'obs-'))
    const fingerprint = figureDerivationFingerprint(figureInput)

    await recordStructureObservation(root, 'session-1', {
      kind: 'figure-derivation',
      figureDerivation: {
        page: 2,
        index: 1,
        bbox: figureInput.bbox,
        figureClass: 'chart',
        inputFingerprint: fingerprint,
        derivation: { kind: 'refused', reason: 'no-numbers-in-box' }
      }
    })

    const journal = await readSessionStructureObservations(root, 'session-1')
    expect(journal.state).toBe('available')
    if (journal.state !== 'available') throw new Error('unreachable')
    expect(journal.entries).toHaveLength(1)
    const entry = journal.entries[0]
    expect(entry?.kind).toBe('figure-derivation')
    expect(entry?.figureDerivation?.figureClass).toBe('chart')
    expect(entry?.figureDerivation?.inputFingerprint).toBe(fingerprint)
    // 指纹是 `sha256:<64 hex>`，且**换输入就变** ⇒ 读侧据此把旧结果标过期。
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(figureDerivationFingerprint({ ...figureInput, page: 3 })).not.toBe(fingerprint)
  })

  it('三种 kind 共存，顺序保持（同一套载体，不给插图另起一套账）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'obs-'))
    await recordStructureObservation(root, 'session-2', {
      kind: 'selection',
      selection: {
        structureId: '1cbs',
        chain: 'A',
        residueStart: 22,
        residueEnd: 30,
        representation: 'cartoon',
        fingerprint: `sha256:${'c'.repeat(64)}`
      } as never
    })
    await recordStructureObservation(root, 'session-2', {
      kind: 'figure-derivation',
      figureDerivation: {
        page: 1,
        index: 1,
        bbox: { x: 0, y: 0, width: 10, height: 10 },
        figureClass: 'undetermined',
        inputFingerprint: figureDerivationFingerprint({
          page: 1,
          bbox: { x: 0, y: 0, width: 10, height: 10 },
          inFigureText: []
        }),
        derivation: { kind: 'refused', reason: 'undetermined', detail: 'no-signals' }
      }
    })

    const journal = await readSessionStructureObservations(root, 'session-2')
    if (journal.state !== 'available') throw new Error('unreachable')
    expect(journal.entries.map((entry) => entry.kind)).toEqual(['selection', 'figure-derivation'])
  })

  it('kind 写着派生而内容读不出来的行**不算一条**（空白行比没有更糟）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'obs-'))
    const path = join(root, '.structure-observations', 'session-3.json')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(root, '.structure-observations'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        entries: [
          { recordedAt: new Date().toISOString(), kind: 'figure-derivation' },
          {
            recordedAt: new Date().toISOString(),
            kind: 'figure-derivation',
            figureDerivation: {
              page: 1,
              index: 1,
              bbox: {},
              figureClass: 'chart',
              inputFingerprint: 'nope',
              derivation: {}
            }
          }
        ],
        dropped: 0
      }),
      'utf8'
    )

    const journal = await readSessionStructureObservations(root, 'session-3')
    if (journal.state !== 'available') throw new Error('unreachable')
    expect(journal.entries).toHaveLength(0)
  })
})
