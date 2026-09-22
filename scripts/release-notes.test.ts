import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  composeReleaseBody,
  extractChangelogSection,
  extractGeneratedTail,
  extractMaturityBlock
} from './release-notes.mjs'

const root = resolve(__dirname, '..')
const readRepo = (name: string): string => readFileSync(resolve(root, name), 'utf8')

describe('release notes composition', () => {
  it('takes one version out of the changelog and stops at the next version heading', () => {
    const changelog = [
      '# 更新日志',
      '',
      '## v9.9.9 — 2099-01-01（测试）',
      '',
      '正文甲',
      '',
      '## v9.9.8 — 2098-01-01（测试）',
      '',
      '正文乙'
    ].join('\n')

    const section = extractChangelogSection(changelog, '9.9.9')

    expect(section).toContain('正文甲')
    expect(section).not.toContain('正文乙')
    expect(section.startsWith('## v9.9.9')).toBe(true)
  })

  it('fails by name when the version has no changelog section', () => {
    expect(() => extractChangelogSection('## v1.0.0 — x\n\nbody', '1.0.1')).toThrow(
      /CHANGELOG\.md has no section for v1\.0\.1/
    )
  })

  it('takes the maturity block up to the next heading and drops the version banner', () => {
    const readme = [
      '# PureScience',
      '',
      '## Maturity and Known Limitations',
      '',
      'A line.',
      '',
      '> 💡 **[PureScience v1.2.3 released](https://example.test)** — banner text',
      '',
      '<p align="center">',
      '  <img src="docs/title.png" alt="PureScience" width="620" />',
      '</p>',
      '',
      '## Table of Contents',
      '',
      '- [x](#x)'
    ].join('\n')

    const block = extractMaturityBlock(readme)

    expect(block.startsWith('## Maturity and Known Limitations')).toBe(true)
    expect(block).toContain('A line.')
    expect(block).not.toContain('banner text')
    expect(block).not.toContain('title.png')
    expect(block).not.toContain('Table of Contents')
  })

  it('fails by name when the maturity section is missing', () => {
    expect(() => extractMaturityBlock('# PureScience\n\nnothing here')).toThrow(
      /README has no "## Maturity and Known Limitations" section/
    )
  })

  it('orders maturity, then the changelog entry, then the generated notes, and omits an empty tail', () => {
    const body = composeReleaseBody({
      maturity: 'M',
      changelog: 'C',
      generated: 'G'
    })
    expect(body.indexOf('M')).toBeLessThan(body.indexOf('C'))
    expect(body.indexOf('C')).toBeLessThan(body.indexOf('G'))
    expect(body.endsWith('\n')).toBe(true)

    const withoutTail = composeReleaseBody({ maturity: 'M', changelog: 'C' })
    expect(withoutTail.trim()).toBe('M\n\n---\n\nC')
  })

  it('keeps the generated PR list when the current body carries one', () => {
    const current =
      "## Maturity and Known Limitations\n\nold\n\n## What's Changed\n* x by @y in #1\n\n**Full Changelog**: a...b"
    const tail = extractGeneratedTail(current)
    expect(tail.startsWith("## What's Changed")).toBe(true)
    expect(tail).toContain('Full Changelog')
    expect(extractGeneratedTail('no generated notes here')).toBe('')
  })

  it('reads the repository sources: the shipped version has both blocks and they carry the labels', () => {
    const changelog = readRepo('CHANGELOG.md')
    const readme = readRepo('README.en.md')
    const version = JSON.parse(readRepo('package.json')).version

    const section = extractChangelogSection(changelog, version)
    const maturity = extractMaturityBlock(readme)

    expect(section.startsWith(`## v${version}`)).toBe(true)
    expect(section.length).toBeGreaterThan(400)
    expect(maturity).toContain('✅')
    expect(maturity).toContain('🚧')
    expect(maturity).toContain('🗺️')
    // The claim the release page repeats must name the same version the package declares.
    expect(readme).toContain(`PureScience v${version} released`)
  })
})
