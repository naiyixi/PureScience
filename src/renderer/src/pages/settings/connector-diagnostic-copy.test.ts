import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseConnectorTemplate } from '../../../../main/settings/connector-template'
import type { ConnectorTemplateDiagnostic } from '../../../../shared/settings'
import { de } from '../../i18n/de'
import { en } from '../../i18n/en'
import { es } from '../../i18n/es'
import { fr } from '../../i18n/fr'
import { ja } from '../../i18n/ja'
import { ko } from '../../i18n/ko'
import { ru } from '../../i18n/ru'
import { zh } from '../../i18n/zh'
import { zhHant } from '../../i18n/zh-Hant'
import { connectorDiagnosticCopy } from './connector-diagnostic-copy'

// The parser composes a canonical English sentence per code; this table composes the sentence the
// reader sees. Two ways that pairing silently breaks: a code gains no sentence (the reader gets
// English) and the sentence drifts from the parser's wording (the English UI changes for no reason).
// Both are caught here without hand-copying 34 sentences: each fixture is a real invalid document,
// and every diagnostic the parser produces must render to exactly the sentence it carries.

const DICTIONARIES: Array<[string, Record<string, string>]> = [
  ['en', en],
  ['zh', zh],
  ['zh-Hant', zhHant],
  ['ja', ja],
  ['ko', ko],
  ['de', de],
  ['fr', fr],
  ['es', es],
  ['ru', ru]
]

const render = (
  diagnostic: ConnectorTemplateDiagnostic,
  dictionary: Record<string, string>
): string | undefined => {
  const copy = connectorDiagnosticCopy(diagnostic)
  if (!copy) return undefined
  const template = dictionary[copy.key]
  if (template === undefined) return undefined
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    copy.values[name] === undefined ? match : copy.values[name]
  )
}

const base = {
  schemaVersion: 1,
  kind: 'purescience.connector',
  name: 'example-research',
  transport: 'stdio',
  command: 'npx'
}

const fixtures: Array<{
  label: string
  contents: string
  options?: Parameters<typeof parseConnectorTemplate>[1]
}> = [
  { label: 'missing name', contents: JSON.stringify({ ...base, name: undefined }) },
  { label: 'name is a number', contents: JSON.stringify({ ...base, name: 5 }) },
  { label: 'args is a string', contents: JSON.stringify({ ...base, args: 'npx' }) },
  { label: 'oauth is a string', contents: JSON.stringify({ ...base, oauth: 'x' }) },
  { label: 'blank name', contents: JSON.stringify({ ...base, name: '   ' }) },
  { label: 'name too long', contents: JSON.stringify({ ...base, name: 'a'.repeat(200) }) },
  {
    label: 'too many args',
    contents: JSON.stringify({ ...base, args: Array.from({ length: 129 }, (_, i) => `--a${i}`) })
  },
  { label: 'file too large', contents: 'x'.repeat(300 * 1024) },
  {
    label: 'unsafe secret name',
    contents: JSON.stringify({ ...base, requiredSecrets: { environment: ['bad name'] } })
  },
  { label: 'unknown field', contents: JSON.stringify({ ...base, bogus: 1 }) },
  { label: 'not json', contents: '{' },
  { label: 'root is an array', contents: '[]' },
  { label: 'wrong schema version', contents: JSON.stringify({ ...base, schemaVersion: 2 }) },
  { label: 'wrong kind', contents: JSON.stringify({ ...base, kind: 'other' }) },
  { label: 'unsafe slug', contents: JSON.stringify({ ...base, slug: 'Bad Slug' }) },
  { label: 'unknown transport', contents: JSON.stringify({ ...base, transport: 'grpc' }) },
  { label: 'stdio without command', contents: JSON.stringify({ ...base, command: undefined }) },
  {
    label: 'url is not a url',
    contents: JSON.stringify({ ...base, transport: 'sse', url: 'nope' })
  },
  {
    label: 'url protocol',
    contents: JSON.stringify({ ...base, transport: 'sse', url: 'ftp://example.test/mcp' })
  },
  {
    label: 'url credentials',
    contents: JSON.stringify({ ...base, transport: 'sse', url: 'https://u:p@example.test/mcp' })
  },
  {
    label: 'url secret',
    contents: JSON.stringify({
      ...base,
      transport: 'sse',
      url: 'https://example.test/mcp?token=abc'
    })
  },
  { label: 'remote without url', contents: JSON.stringify({ ...base, transport: 'sse' }) },
  { label: 'local command', contents: JSON.stringify({ ...base, command: '/usr/bin/node' }) },
  { label: 'local argument', contents: JSON.stringify({ ...base, args: ['/usr/bin/server.mjs'] }) },
  { label: 'argument line break', contents: JSON.stringify({ ...base, args: ['a\nb'] }) },
  { label: 'argument secret', contents: JSON.stringify({ ...base, args: ['--api-key=abc'] }) },
  {
    label: 'stdio with url',
    contents: JSON.stringify({ ...base, url: 'https://example.test/mcp' })
  },
  {
    label: 'stdio with header secrets',
    contents: JSON.stringify({ ...base, requiredSecrets: { headers: ['Authorization'] } })
  },
  {
    label: 'remote with command',
    contents: JSON.stringify({ ...base, transport: 'sse', url: 'https://example.test/mcp' })
  },
  {
    label: 'remote with environment secrets',
    contents: JSON.stringify({
      ...base,
      transport: 'sse',
      url: 'https://example.test/mcp',
      requiredSecrets: { environment: ['API_TOKEN'] }
    })
  },
  {
    label: 'oauth with header secrets',
    contents: JSON.stringify({
      ...base,
      transport: 'sse',
      url: 'https://example.test/mcp',
      oauth: { scopes: ['read'] },
      requiredSecrets: { headers: ['Authorization'] }
    })
  },
  {
    label: 'name reserved by a built-in connector',
    contents: JSON.stringify(base),
    options: { bundledIds: ['example-research'] }
  },
  {
    label: 'name already installed',
    contents: JSON.stringify(base),
    options: { existingNames: ['Example-Research'] }
  },
  {
    label: 'name conflicts with an installed alias',
    contents: JSON.stringify(base),
    options: { existingSlugs: ['example-research'] }
  },
  {
    label: 'slug reserved by a built-in connector',
    contents: JSON.stringify({ ...base, slug: 'example-research' }),
    options: { bundledIds: ['example-research'] }
  },
  {
    label: 'slug already installed',
    contents: JSON.stringify({ ...base, slug: 'example-research' }),
    options: { existingSlugs: ['example-research'] }
  },
  {
    label: 'slug conflicts with an installed name',
    contents: JSON.stringify({ ...base, slug: 'example-research' }),
    options: { existingNames: ['example-research'] }
  }
]

const produced = fixtures.flatMap((fixture) => {
  const preview = parseConnectorTemplate(fixture.contents, fixture.options ?? {})
  return preview.diagnostics.map((diagnostic) => ({ label: fixture.label, diagnostic }))
})

describe('connector diagnostic copy', () => {
  it('renders every diagnostic the parser produces to the sentence it carries', () => {
    expect(produced.length).toBeGreaterThan(fixtures.length)
    const mismatches = produced.flatMap(({ label, diagnostic }) => {
      const rendered = render(diagnostic, en)
      if (rendered === undefined) return [{ label, code: diagnostic.code, rendered: '(no copy)' }]
      if (rendered !== diagnostic.message) {
        return [{ label, code: diagnostic.code, rendered, message: diagnostic.message }]
      }
      return []
    })
    expect(mismatches).toEqual([])
  })

  it('has a sentence for every code the parser can emit', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/settings/connector-template.ts'),
      'utf8'
    )
    const codes = new Set(
      Array.from(source.matchAll(/'connector-template\.[a-z-]+'/g), (match) =>
        match[0].slice(1, -1)
      )
    )
    // A scan that found nothing would make the coverage claim below vacuous.
    expect(codes.size).toBeGreaterThan(20)

    const exercised = new Set(produced.map(({ diagnostic }) => diagnostic.code))
    expect([...codes].filter((code) => !exercised.has(code))).toEqual([])
    expect([...exercised].filter((code) => !codes.has(code))).toEqual([])
  })

  it('keeps nine languages, none of them leaving a placeholder behind or reusing the English text', () => {
    const problems = produced.flatMap(({ label, diagnostic }) => {
      const english = render(diagnostic, en) ?? ''
      return DICTIONARIES.flatMap(([language, dictionary]) => {
        const rendered = render(diagnostic, dictionary)
        if (rendered === undefined) return [{ label, language, issue: 'missing sentence' }]
        const issues: Array<{ label: string; language: string; issue: string }> = []
        if (/\{\w+\}/.test(rendered)) issues.push({ label, language, issue: 'placeholder left' })
        if (language !== 'en' && rendered === english) {
          issues.push({ label, language, issue: 'same as English' })
        }
        return issues
      })
    })
    expect(problems).toEqual([])
  })

  it('falls back to the canonical sentence instead of half a sentence', () => {
    expect(
      connectorDiagnosticCopy({
        severity: 'error',
        code: 'connector-template.unknown',
        message: 'x'
      })
    ).toBeUndefined()
    expect(
      connectorDiagnosticCopy({
        severity: 'error',
        code: 'connector-template.url-secret',
        message: 'x'
      })
    ).toBeUndefined()
    expect(
      connectorDiagnosticCopy({
        severity: 'error',
        code: 'connector-template.too-long',
        message: 'x',
        path: 'name'
      })
    ).toBeUndefined()
    expect(
      connectorDiagnosticCopy({
        severity: 'error',
        code: 'connector-template.identity-conflict',
        message: 'x',
        path: 'name',
        params: { value: 'a', kind: 'something-else' }
      })
    ).toBeUndefined()
  })
})
