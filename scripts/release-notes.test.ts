import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  composeReleaseBody,
  extractChangelogSection,
  extractGeneratedTail,
  extractMacSigningDisclosure,
  extractMaturityBlock
} from './release-notes.mjs'
import { MAC_SIGNING_DISCLOSURE_MARKER, macSigningDisclosure } from './ci/mac-signing-status.mjs'

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

  // A reader deciding whether to install reads this page. It leads with maturity and the reader-facing
  // 亮点 block; the engineering record stays collapsed; the generated PR list is dropped, because a list of
  // pull-request titles is exactly the work log the page is trying not to be.
  it('leads with the reader-facing block, keeps the record collapsed, and drops the PR list', () => {
    const changelog = ['### 亮点', '', '- 首启不再等十几分钟', '', '### 工程记录', '', '细节'].join('\n')
    const body = composeReleaseBody({ maturity: 'M', changelog, generated: 'G' })

    expect(body.startsWith('M')).toBe(true)
    expect(body.indexOf('首启不再等十几分钟')).toBeLessThan(body.indexOf('<details>'))
    expect(body).toContain('<details>')
    expect(body).toContain('### 工程记录')
    expect(body).not.toContain('G')
    expect(body.endsWith('\n')).toBe(true)

    // No 亮点 block: everything the entry carries is the record, so it goes into the collapsed part.
    const withoutHighlights = composeReleaseBody({ maturity: 'M', changelog: 'C' })
    expect(withoutHighlights.trim()).toBe('M\n\n---\n\n<details>\n<summary>技术记录</summary>\n\nC\n\n</details>')
  })

  it('puts the macOS signing disclosure directly under the maturity block', () => {
    const disclosure = macSigningDisclosure('unsigned') as string
    const body = composeReleaseBody({
      maturity: 'M',
      changelog: 'C',
      generated: 'G',
      disclosure
    })

    expect(body.indexOf('M')).toBeLessThan(body.indexOf(disclosure))
    expect(body.indexOf(disclosure)).toBeLessThan(body.indexOf('C'))
    expect(body).toContain(MAC_SIGNING_DISCLOSURE_MARKER)
    // A signed release adds nothing: the page keeps its shape without a disclosure paragraph.
    expect(composeReleaseBody({ maturity: 'M', changelog: 'C', disclosure: '' })).not.toContain(
      MAC_SIGNING_DISCLOSURE_MARKER
    )
  })

  it('keeps an existing macOS signing disclosure out of the current body', () => {
    const disclosure = macSigningDisclosure('unsigned') as string
    const current = `## Maturity\n\nold\n\n${disclosure}\n\n## What's Changed\n* x by @y in #1`

    expect(extractMacSigningDisclosure(current)).toBe(disclosure)
    expect(extractMacSigningDisclosure("## What's Changed\n* x")).toBe('')
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
