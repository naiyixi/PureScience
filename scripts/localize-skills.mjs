// Applies the Chinese localization of third-party skill descriptions.
//
// Rule 2.3 is narrow on purpose: translate the process description, never touch the author's attribution. So this
// script writes `description-zh:` *beside* the original `description:` — the English text stays exactly as the
// author wrote it, and nothing else in the frontmatter (name, author, license, allowed-tools) is touched.
//
// Idempotent: re-running rewrites the same line, and a description that is missing from the mapping keeps
// whatever it had (a partially localized tree is a valid state, and the report says how far it got).
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const skillsRoot = join(repoRoot, 'resources', 'skills')
const mappingFile = join(repoRoot, 'scripts', 'skill-localizations.zh-CN.json')

const mapping = JSON.parse(await readFile(mappingFile, 'utf8')).skills
const manifest = JSON.parse(await readFile(join(skillsRoot, 'manifest.json'), 'utf8'))

const KEY = 'description-zh:'
const localized = []
const skipped = []

for (const [id, chinese] of Object.entries(mapping)) {
  const thirdParty = manifest.skills.find((skill) => skill.id === id)?.thirdParty
  if (thirdParty === undefined) {
    skipped.push({ id, why: '不是第三方技能（2.3 只覆盖引入的集合）' })
    continue
  }
  const file = join(skillsRoot, id, 'SKILL.md')
  const text = await readFile(file, 'utf8')
  if (!text.startsWith('---')) {
    skipped.push({ id, why: '没有 frontmatter' })
    continue
  }
  const end = text.indexOf('\n---', 3)
  if (end === -1) {
    skipped.push({ id, why: 'frontmatter 未闭合' })
    continue
  }
  const body = text.slice(3, end)
  const rest = text.slice(end)
  const lines = body.split('\n')

  // Drop an existing localization first so re-running does not stack copies.
  const withoutZh = lines.filter((line) => !line.startsWith(KEY))
  const descriptionIndex = withoutZh.findIndex((line) => /^description:/.test(line))
  if (descriptionIndex === -1) {
    skipped.push({ id, why: '没有 description 字段' })
    continue
  }
  // `description:` may be a folded block ( `>` + indented lines ); the Chinese line goes after the whole block.
  let insertAt = descriptionIndex + 1
  while (insertAt < withoutZh.length && /^\s+\S/.test(withoutZh[insertAt])) insertAt += 1
  withoutZh.splice(insertAt, 0, `${KEY} ${chinese}`)

  await writeFile(file, `---${withoutZh.join('\n')}${rest}`)
  localized.push(id)
}

const total = manifest.skills.filter((skill) => skill.thirdParty !== undefined).length
console.log(
  JSON.stringify(
    {
      localized: localized.length,
      thirdPartyTotal: total,
      remaining: total - localized.length,
      skipped
    },
    null,
    2
  )
)
