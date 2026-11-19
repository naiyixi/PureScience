// Guards the third-party import: the manifest, the directories on disk and ATTRIBUTION.md must describe the same
// set. A skill can be deleted, a manifest row can be dropped, or an attribution line can go missing during a
// merge — each of those silently changes what we redistribute and on whose behalf.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const skillsRoot = join(process.cwd(), 'resources', 'skills')
const manifest = JSON.parse(readFileSync(join(skillsRoot, 'manifest.json'), 'utf8')) as {
  skills: { id: string; name: string; source: string; thirdParty?: string }[]
}
const attribution = readFileSync(join(skillsRoot, 'ATTRIBUTION.md'), 'utf8')

// Bundled entries all declare `source: 'featured'` — the registry drops any other value — so the third-party
// set is identified by its id prefix, which the importer assigns.
const thirdParty = manifest.skills.filter((skill) => skill.thirdParty !== undefined)
const directories = new Set(
  readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
)

describe('bundled third-party skills', () => {
  it('has a manifest row and a directory for every imported skill, and no orphan directories', () => {
    const missingDir = thirdParty.filter((skill) => !directories.has(skill.id))
    expect(missingDir.map((skill) => skill.id)).toEqual([])

    // Imported ids are usually the author's own `name`, so they are not prefixed; the manifest's `thirdParty`
    // column is what marks them.
    const unlisted = [...directories].filter(
      (name) => !manifest.skills.some((skill) => skill.id === name) && name !== 'licenses'
    )
    expect(unlisted).toEqual([])
    // Both collections are actually present, not a token import.
    // `thirdParty` carries the collection title (the label the panel shows), not the repository path.
    const byTitle = (needle: string): number =>
      thirdParty.filter((skill) => (skill.thirdParty ?? '').includes(needle)).length
    expect(byTitle('科研技能集合')).toBeGreaterThan(100)
    expect(byTitle('AI 研究技能集合')).toBeGreaterThan(50)
  })

  it('names every imported skill in ATTRIBUTION.md, with its source path and license', () => {
    const missing = thirdParty.filter((skill) => !attribution.includes(`\`${skill.id}\``))
    expect(missing.map((skill) => skill.id)).toEqual([])
  })

  it('ships the license text for each collection and says where it is', () => {
    for (const collection of ['sci', 'air']) {
      const licenseDir = join(skillsRoot, 'licenses')
      const files = readdirSync(licenseDir).filter((name) => name.startsWith(`${collection}-`))
      expect(files.length, `${collection} license file`).toBeGreaterThan(0)
      const [file] = files
      expect(attribution.includes(`licenses/${file}`)).toBe(true)
      expect(readFileSync(join(licenseDir, file ?? ''), 'utf8').length).toBeGreaterThan(100)
    }
  })

  // 2.3's rule in test form: the translation is an addition, never a replacement, and the author's attribution
  // is not part of what gets localized.
  it('localized descriptions sit beside the original text and leave attribution alone', () => {
    const localized = thirdParty.filter((skill) => {
      const file = join(skillsRoot, skill.id, 'SKILL.md')
      return existsSync(file) && readFileSync(file, 'utf8').includes('\ndescription-zh:')
    })
    // The spot-check sample the roadmap asks for, plus a couple.
    expect(localized.length).toBeGreaterThanOrEqual(20)

    const offenders: string[] = []
    for (const skill of localized) {
      const text = readFileSync(join(skillsRoot, skill.id, 'SKILL.md'), 'utf8')
      const head = text.split('\n---')[0] ?? ''
      const chinese = /description-zh:\s*(.+)/.exec(head)?.[1] ?? ''
      // Real Chinese text, not a placeholder or a copy of the English line.
      if (!/[\u4e00-\u9fff]/.test(chinese)) offenders.push(`${skill.id}: 中文为空或非中文`)
      if (/^description:\s*[^\n]*[\u4e00-\u9fff]/.test(head))
        offenders.push(`${skill.id}: 原文被改成了中文`)
      if (!/\n(author|\s+skill-author):/.test(head)) offenders.push(`${skill.id}: 署名字段消失`)
    }
    expect(offenders).toEqual([])
  })

  it('never imports a skill whose own license forbids redistribution', () => {
    // Frontmatter is the author's statement of terms; the importer refuses GPL, non-commercial and unstated
    // licenses. This re-checks the shipped tree so a hand-copy cannot slip past it.
    const forbidden =
      /(^|\n)license:\s*(.*\b(gpl|agpl|noncommercial|non-commercial|polyform|proprietary|unknown)\b|.*\bby-nc)/i
    const offenders: string[] = []
    for (const skill of thirdParty) {
      const skillFile = join(skillsRoot, skill.id, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const head = readFileSync(skillFile, 'utf8').split('\n---')[0] ?? ''
      if (forbidden.test(head)) offenders.push(skill.id)
    }
    expect(offenders).toEqual([])
  })
})
