import { createHash } from 'node:crypto'

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { createSessionPackage, type SessionPackageInput } from './export'
import { inspectSessionPackage, REQUIRED_PACKAGE_EVIDENCE } from './import'

const input = (): SessionPackageInput => ({
  session: { id: 'session-1', title: 'Mpro 模拟', projectId: 'project-1' },
  appVersion: '1.59.0',
  exportedAt: '2026-09-15T00:00:00.000Z',
  conversation: { messages: [{ role: 'user', text: '模拟一下分子对接' }] },
  citations: [{ id: 'cite-1' }],
  reviewFindings: [{ id: 'finding-1' }],
  verificationRecords: [{ id: 'verify-1' }]
})

const packageBytes = (
  overrides: Partial<SessionPackageInput> = {},
  mode: 'essential' | 'full' = 'essential'
): Uint8Array => createSessionPackage({ ...input(), ...overrides }, mode).archive

describe('session package inspection', () => {
  it('accepts a package the exporter wrote, and describes it without claiming its verification', () => {
    const preview = inspectSessionPackage(packageBytes())

    expect(preview.accepted).toBe(true)
    expect(preview.described?.session).toEqual({
      id: 'session-1',
      title: 'Mpro 模拟',
      projectId: 'project-1'
    })
    expect(preview.described?.counts.messages).toBe(1)
    // The sender's own words about provenance travel unchanged into the preview.
    expect(preview.described?.assertion).toEqual({ origin: 'source-party', locallyVerified: false })
  })

  it('reports what it recomputed — usage and the tool-call readings — with the declaration beside them', () => {
    // A package whose transcript records one turn with a usage record, and whose tool readings were
    // actually collected: both halves must come back as `match`, and the tool half must say it was
    // `included` so a reader can tell a verified row count from a "nothing was collected" absence.
    const rows = [{ turnId: 'turn-1', tool: 'repl_execute', durationMs: 12, resultBytes: 3 }]
    const file = strToU8(JSON.stringify({ recipe: 'tool-call-readings:v1', rows, unnamed: 0 }))
    const archive = packageBytes({
      conversation: {
        messages: [
          { role: 'user', text: '模拟一下分子对接' },
          {
            role: 'agent',
            text: '完成',
            turnUsage: { inputTokens: 1200, outputTokens: 300 }
          }
        ]
      },
      toolReadings: {
        summary: {
          recipe: 'tool-call-readings:v1',
          state: 'included',
          rows: rows.length,
          unnamed: 0,
          sha256: createHash('sha256').update(file).digest('hex')
        },
        file: { path: 'evidence/tool-calls.json', contents: file }
      }
    })

    const preview = inspectSessionPackage(archive)
    expect(preview.accepted).toBe(true)
    expect(preview.described?.readings).toEqual({
      usage: {
        state: 'match',
        derived: { turns: 1, inputTokens: 1200, outputTokens: 300, turnsWithoutUsage: 0 }
      },
      toolCalls: { state: 'match', rows: 1, unnamed: 0 },
      toolCallsDeclared: {
        recipe: 'tool-call-readings:v1',
        state: 'included',
        rows: 1,
        unnamed: 0,
        sha256: createHash('sha256').update(file).digest('hex')
      }
    })
  })

  it('refuses bytes that are not an archive at all', () => {
    expect(inspectSessionPackage(strToU8('this is not a zip'))).toEqual({
      accepted: false,
      reason: 'not-a-package'
    })
  })

  it('refuses an archive with no manifest', () => {
    const archive = zipSync({ 'notes.txt': strToU8('hello') })
    expect(inspectSessionPackage(archive)).toEqual({ accepted: false, reason: 'not-a-package' })
  })

  it('refuses a manifest it cannot parse', () => {
    const archive = zipSync({
      'manifest.json': strToU8('{not json'),
      ...Object.fromEntries(REQUIRED_PACKAGE_EVIDENCE.map((path) => [path, strToU8('{}')]))
    })
    expect(inspectSessionPackage(archive)).toEqual({ accepted: false, reason: 'manifest-invalid' })
  })

  it('refuses a format version this build does not know', () => {
    const { archive } = createSessionPackage(input(), 'essential')
    // Rewrite the version the way a newer build would have written it.
    const entries = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          formatVersion: 99,
          mode: 'essential',
          exportedAt: '2026-09-15T00:00:00.000Z',
          app: { version: '9.9.9' },
          session: { id: 's', title: 't', projectId: 'p' },
          counts: {
            messages: 0,
            citations: 0,
            reviewFindings: 0,
            verificationRecords: 0,
            files: 0
          },
          entries: [],
          assertion: { origin: 'source-party', locallyVerified: false },
          notes: []
        })
      ),
      ...Object.fromEntries(REQUIRED_PACKAGE_EVIDENCE.map((path) => [path, strToU8('{}')]))
    })
    expect(archive.byteLength).toBeGreaterThan(0)
    expect(inspectSessionPackage(entries)).toEqual({
      accepted: false,
      reason: 'unsupported-format-version'
    })
  })

  it('refuses a package that dropped a piece of required evidence', () => {
    const { archive } = createSessionPackage(input(), 'essential')
    const entries = new Map(Object.entries(unzipSync(archive)))
    // Rebuild the archive without one evidence file.
    const rebuilt = zipSync(
      Object.fromEntries([...entries].filter(([name]) => name !== 'evidence/verifications.json'))
    )
    console.log('DROPPED_EVIDENCE_REASON', inspectSessionPackage(rebuilt).reason)
    expect(inspectSessionPackage(rebuilt)).toEqual({
      accepted: false,
      reason: 'required-evidence-missing'
    })
  })

  it('refuses an entry path that would escape the extraction directory', () => {
    const { archive } = createSessionPackage(input(), 'essential')
    const entries = Object.entries(unzipSync(archive)).filter(
      ([name]) => name !== 'conversation.json'
    )
    const hostile = zipSync({
      ...Object.fromEntries(entries),
      '../escape.json': strToU8('{}')
    })
    expect(inspectSessionPackage(hostile)).toEqual({ accepted: false, reason: 'entry-path-unsafe' })
  })

  it('refuses a package that exceeds the entry-count ceiling', () => {
    const many: Record<string, Uint8Array> = {}
    for (let index = 0; index < 5_001; index += 1) many[`filler/${index}.json`] = strToU8('{}')
    expect(inspectSessionPackage(zipSync(many))).toEqual({
      accepted: false,
      reason: 'entry-count-exceeded'
    })
  })

  it('hashes nothing on trust: the described package still carries the sender’s hashes', () => {
    const { archive, manifest } = createSessionPackage(input(), 'full')
    const preview = inspectSessionPackage(archive)
    const conversationEntry = manifest.entries.find((entry) => entry.path === 'conversation.json')
    const bytes = unzipSync(archive)['conversation.json']

    expect(preview.accepted).toBe(true)
    expect(conversationEntry?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('refuses a manifest whose cost summary disagrees with the transcript it carries', () => {
    const { archive } = createSessionPackage(input(), 'essential')
    const entries = unzipSync(archive)
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
      usage?: Record<string, unknown>
    }
    // The sender's own summary, inflated: the transcript that travelled does not support it.
    const tampered = zipSync({
      ...Object.fromEntries(Object.entries(entries)),
      'manifest.json': strToU8(
        JSON.stringify({ ...manifest, usage: { ...manifest.usage, inputTokens: 999_999 } })
      )
    })

    expect(inspectSessionPackage(tampered)).toEqual({ accepted: false, reason: 'manifest-invalid' })
  })

  it('accepts a package written before the summary existed, and never reads absence as a match', () => {
    const { archive } = createSessionPackage(input(), 'essential')
    const entries = unzipSync(archive)
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as Record<string, unknown>
    const { usage: _omitted, ...legacy } = manifest
    const legacyArchive = zipSync({
      ...Object.fromEntries(Object.entries(entries)),
      'manifest.json': strToU8(JSON.stringify(legacy))
    })

    expect(inspectSessionPackage(legacyArchive).accepted).toBe(true)
  })
})

describe('the importer checks the tool-call readings against the bytes', () => {
  const readingsInput = (): Partial<SessionPackageInput> => {
    const contents = strToU8(
      JSON.stringify({
        recipe: 'tool-call-readings:v1',
        rows: [{ turnId: 'a1', tool: 'notebook_execute', durationMs: 120 }],
        unnamed: 1
      })
    )
    return {
      toolReadings: {
        file: { path: 'evidence/tool-calls.json', contents },
        summary: {
          recipe: 'tool-call-readings:v1',
          state: 'included',
          rows: 1,
          unnamed: 1,
          sha256: createHash('sha256').update(contents).digest('hex')
        }
      }
    }
  }

  const rebuild = (
    archive: Uint8Array,
    change: (entries: Record<string, Uint8Array>) => Record<string, Uint8Array>
  ): Uint8Array => zipSync(change(unzipSync(archive)))

  it('accepts the package and describes the readings it verified', () => {
    const { archive } = createSessionPackage({ ...input(), ...readingsInput() }, 'essential')
    const preview = inspectSessionPackage(archive)

    expect(preview.accepted).toBe(true)
    expect(preview.described?.toolReadings).toEqual({
      recipe: 'tool-call-readings:v1',
      state: 'included',
      rows: 1,
      unnamed: 1,
      sha256: createHash('sha256')
        .update(
          strToU8(
            JSON.stringify({
              recipe: 'tool-call-readings:v1',
              rows: [{ turnId: 'a1', tool: 'notebook_execute', durationMs: 120 }],
              unnamed: 1
            })
          )
        )
        .digest('hex')
    })
  })

  it('refuses a package whose readings bytes no longer hash to its own record', () => {
    const { archive } = createSessionPackage({ ...input(), ...readingsInput() }, 'essential')
    const tampered = rebuild(archive, (entries) => ({
      ...entries,
      'evidence/tool-calls.json': strToU8(
        JSON.stringify({
          recipe: 'tool-call-readings:v1',
          rows: [{ turnId: 'a1', tool: 'something-else', durationMs: 120 }],
          unnamed: 1
        })
      )
    }))

    expect(inspectSessionPackage(tampered)).toEqual({
      accepted: false,
      reason: 'manifest-invalid'
    })
  })

  it('refuses a declaration that overstates how many calls the file holds', () => {
    const { archive } = createSessionPackage({ ...input(), ...readingsInput() }, 'essential')
    const inflated = rebuild(archive, (entries) => {
      const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
        toolReadings?: Record<string, unknown>
      }
      return {
        ...entries,
        'manifest.json': strToU8(
          JSON.stringify({
            ...manifest,
            toolReadings: { ...manifest.toolReadings, rows: 40 }
          })
        )
      }
    })

    expect(inspectSessionPackage(inflated)).toEqual({
      accepted: false,
      reason: 'manifest-invalid'
    })
  })

  it('still accepts a package written before readings travelled, and names the absence', () => {
    const { archive } = createSessionPackage(input(), 'essential')
    const legacy = rebuild(archive, (entries) => {
      const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as Record<string, unknown>
      const { toolReadings: _omitted, ...rest } = manifest
      return { ...entries, 'manifest.json': strToU8(JSON.stringify(rest)) }
    })
    const preview = inspectSessionPackage(legacy)

    expect(preview.accepted).toBe(true)
    // 老包没有这一段：界面上它必须与「这次没调工具」分开讲，所以这里读到的是「没有字段」。
    expect(preview.described?.toolReadings).toBeUndefined()
  })
})
