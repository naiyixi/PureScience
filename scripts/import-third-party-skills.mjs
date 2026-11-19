// Imports the two third-party skill collections into resources/skills and writes ATTRIBUTION.md beside them.
//
// The rule this script enforces: a skill is imported only when its own SKILL.md says a license we know permits
// commercial redistribution. The collection's top-level license is not enough — the collections carry skills
// under GPL, non-commercial and "unknown" terms, and shipping those in a paid product is not our call to make.
// Everything excluded is listed with the reason, so a later round can ask the author instead of guessing.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { FAILSAFE_SCHEMA, load as loadYaml } from 'js-yaml'

const repoRoot = new URL('..', import.meta.url).pathname
const skillsRoot = join(repoRoot, 'resources', 'skills')
const sourcesPath = join(repoRoot, 'scripts', 'third-party-skills.sources.json')

// Checked against the frontmatter string after trimming and lowercasing. Order matters: the first pattern that
// matches wins, and the deny list is consulted first so "GPL-3.0-or-later" never lands in the permissive bucket.
const DENY = [
  { match: /(^|\b)(a?gpl)/, reason: 'GPL/AGPL：传染性条款与闭源分发不兼容' },
  { match: /polyform-noncommercial|non-?commercial|nc-|nc\b|by-nc/, reason: '非商业条款' },
  { match: /proprietary/, reason: '专有许可，需单独授权' },
  { match: /unknown|^$/, reason: '许可未声明，按 fail-closed 处理' }
]

const ALLOW = [
  { match: /^mit\b|^mit\b|(^|\s)mit( |$)/, label: 'MIT' },
  { match: /apache/i, label: 'Apache-2.0' },
  { match: /(^|\b)(3-clause|3 clause|bsd-3)/, label: 'BSD-3-Clause' },
  { match: /(^|\b)(2-clause|bsd-2)/, label: 'BSD-2-Clause' },
  { match: /(^|\b)bsd( |$)/, label: 'BSD' },
  { match: /biopython/, label: 'Biopython' },
  { match: /^cc-by-4\.0$|creativecommons\.org\/licenses\/by\/4\.0/, label: 'CC-BY-4.0' },
  { match: /^isc( |$)/, label: 'ISC' }
]

// The app's own reader (`shared/skill-frontmatter`) is the judge of "usable": same regex, same FAILSAFE YAML.
// A file it cannot parse becomes a catalog entry with no description, which is worse than not shipping it.
const parsesWithAppReader = (text) => {
  const normalized = text.replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (match === null) return { ok: false, why: 'no-frontmatter' }
  try {
    const fields = loadYaml(match[1], { schema: FAILSAFE_SCHEMA }) ?? {}
    if (typeof fields.name !== 'string' || fields.name.trim() === '')
      return { ok: false, why: 'no-name' }
    if (typeof fields.description !== 'string' || fields.description.trim() === '')
      return { ok: false, why: 'no-description' }
    return { ok: true, fields }
  } catch (error) {
    return { ok: false, why: `yaml: ${String(error.message).split('\n')[0]}` }
  }
}

const classify = (raw) => {
  const value = (raw ?? '').trim()
  const normalized = value.toLowerCase()
  for (const rule of DENY)
    if (rule.match.test(normalized)) return { ok: false, reason: rule.reason, value }
  for (const rule of ALLOW)
    if (rule.match.test(normalized)) return { ok: true, license: rule.label, value }
  // A URL in `license:` is a description of the *dependency's* terms, not this skill's; it cannot be resolved here.
  return { ok: false, reason: '许可串无法归入允许清单，需人工核对', value }
}

const readFrontmatter = (text) => {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = text.slice(3, end)
  const fields = {}
  for (const line of block.split('\n')) {
    // Leading spaces are meaningful: the collections nest `skill-author` under `metadata:`, and a
    // start-of-line-only pattern silently reported those skills as unattributed.
    const match = /^\s*([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const [, key, rawValue] = match
    fields[key.toLowerCase()] = rawValue.replace(/^["']|["']$/g, '').trim()
  }
  return fields
}

const frontmatterBlock = (text) => {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  return end === -1 ? null : { body: text.slice(3, end), rest: text.slice(end) }
}

// Replaces only the top-level `name:` line of the frontmatter block.
const rewriteName = (text, name) => {
  const block = frontmatterBlock(text)
  if (block === null) return text
  const rewritten = block.body
    .split('\n')
    .map((line) => (/^name:\s*/.test(line) ? `name: ${name}` : line))
    .join('\n')
  return `---${rewritten}${block.rest}`
}

const findSkillDirs = async (root, depth = 0) => {
  const found = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(root, entry.name)
    if (existsSync(join(full, 'SKILL.md'))) {
      found.push(full)
      continue
    }
    // The AI collection nests skills under numbered category directories; two levels is enough for both.
    if (depth < 2) found.push(...(await findSkillDirs(full, depth + 1)))
  }
  return found
}

const sources = JSON.parse(await readFile(sourcesPath, 'utf8'))
const manifestFile = join(skillsRoot, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
// Ours = rows we ship without a `thirdParty` provenance. Filtering on the id prefix alone would keep imported
// rows whose names never needed prefixing, and the next run would append a second copy of each.
const ours = manifest.skills.filter((skill) => skill.thirdParty === undefined)
// Ids already spoken for. A bundled skill's id must equal its own frontmatter `name` (the registry's nudge
// identity check enforces it), so a name we already ship is resolved by namespacing the incoming skill.
const taken = new Set(ours.map((skill) => skill.id))

const attributionRows = []
const excludedRows = []
const renames = []
const importedIds = []
const licenseCopies = []

for (const source of sources) {
  const checkout = process.env[`SKILLS_SOURCE_${source.collection.toUpperCase()}`]
  if (checkout === undefined) {
    throw new Error(
      `missing checkout for ${source.collection}: set SKILLS_SOURCE_${source.collection.toUpperCase()}`
    )
  }
  const licenseText = await readFile(join(checkout, source.licenseFile), 'utf8')
  await mkdir(join(skillsRoot, 'licenses'), { recursive: true })
  const licenseTarget = `licenses/${source.collection}-${source.license}-LICENSE.txt`
  await writeFile(join(skillsRoot, licenseTarget), licenseText)
  licenseCopies.push({
    collection: source.collection,
    path: licenseTarget,
    license: source.license
  })

  const dirs = await findSkillDirs(join(checkout, source.skillsRoot))
  for (const dir of dirs) {
    const relativePath = relative(checkout, dir).split('\\').join('/')
    const frontmatter = readFrontmatter(await readFile(join(dir, 'SKILL.md'), 'utf8'))
    const verdict = classify(frontmatter.license)
    if (!verdict.ok) {
      excludedRows.push({
        relativePath,
        license: verdict.value ?? '',
        reason: verdict.reason,
        name: frontmatter.name ?? ''
      })
      continue
    }

    // Our own reader is the judge of "usable": a frontmatter it cannot parse yields a skill with no
    // description, which the catalog would list as an empty entry. `ray-data`/`ray-train` in the AI collection
    // carry an unquoted flow sequence the YAML parser rejects, so they are reported instead of imported.
    const parsed = parsesWithAppReader(await readFile(join(dir, 'SKILL.md'), 'utf8'))
    if (!parsed.ok) {
      excludedRows.push({
        relativePath,
        license: verdict.value ?? '',
        reason: `我们的解析器读不出来（${parsed.why}），装了也只是个空条目`
      })
      continue
    }

    const declaredName = (frontmatter.name ?? dir.split('/').at(-1) ?? '').toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(declaredName)) {
      excludedRows.push({
        relativePath,
        license: verdict.value ?? '',
        reason: 'name 不是小写连字符标识，与内置技能命名规则冲突'
      })
      continue
    }
    // Namespace only when the name is taken; otherwise the author's name is the id, untouched.
    const id = taken.has(declaredName) ? `${source.idPrefix}-${declaredName}` : declaredName
    if (taken.has(id)) {
      excludedRows.push({
        relativePath,
        license: verdict.value ?? '',
        reason: `id 冲突（${id} 已存在）`
      })
      continue
    }
    taken.add(id)
    const renamed = id !== declaredName
    if (renamed) renames.push({ id, was: declaredName, relativePath })

    const target = join(skillsRoot, id)
    await rm(target, { recursive: true, force: true })
    await cp(dir, target, { recursive: true })
    // The one edit the import makes, and only for collisions: the file's `name:` must equal its directory, so
    // both get the prefix together. Content and attribution are untouched.
    if (renamed) {
      const skillFile = join(target, 'SKILL.md')
      await writeFile(skillFile, rewriteName(await readFile(skillFile, 'utf8'), id))
    }
    importedIds.push(id)
    attributionRows.push({
      id,
      name: id,
      relativePath,
      // Skill-level authorship when the file declares it, otherwise the collection's own attribution — and
      // said which one it is, because "no author stated" and "the collection did it" are different claims.
      author:
        frontmatter.author ??
        frontmatter['skill-author'] ??
        `${source.author}（集合级署名，技能文件未单独署名）`,
      authorLevel:
        frontmatter.author !== undefined || frontmatter['skill-author'] !== undefined
          ? 'skill'
          : 'collection',
      license: verdict.license,
      collection: source.collection,
      repo: source.repo,
      renamed
    })
  }
}

// Drop third-party directories this run did not produce (a removed skill, or an id that changed).
const keepIds = new Set([...importedIds, ...ours.map((skill) => skill.id), 'licenses'])
for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  if (!keepIds.has(entry.name))
    await rm(join(skillsRoot, entry.name), { recursive: true, force: true })
}

// Manifest: append the imported ids, keep the existing entries untouched, sort for a stable diff.
const added = attributionRows.map((row) => ({
  id: row.id,
  // Display name as the author wrote it: an id like `sci-polars-bio` is a slug, not a name a user should read.
  name: row.name,
  // `featured` is what the bundled registry accepts (anything else is filtered out at read time); the
  // distinction from our own skills is the `thirdParty` field and the id prefix, not the source.
  source: 'featured',
  updatedAt: `${sources.find((source) => source.collection === row.collection)?.commitDate ?? '2026-11-19'}T00:00:00.000Z`,
  // The user-visible provenance label, which is why it is the collection title and not the repository path:
  // the app shows this row in the skills panel. The full repository URL and commit live in ATTRIBUTION.md and
  // scripts/third-party-skills.sources.json, which is where attribution belongs.
  thirdParty:
    sources.find((source) => source.collection === row.collection)?.title ?? row.collection,
  license: row.license
}))
// Rebuilt from `ours` + this run's rows: appending to the previous manifest is how a re-run with new ids left
// 467 third-party rows for 236 skills.
manifest.skills = [...ours, ...added].sort((a, b) => a.id.localeCompare(b.id))
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

const lines = []
lines.push('# 第三方技能归属（ATTRIBUTION）')
lines.push('')
lines.push(
  '本目录下的第三方技能按各自许可原样引入：作者署名、许可声明、技能内容都保持原状，只在本文件里登记来源。'
)
lines.push('')
for (const source of sources) {
  lines.push(`## ${source.title}（${source.collection}）`)
  lines.push('')
  lines.push(`- 来源仓库：\`${source.repo}\``)
  lines.push(`- 引入提交：\`${source.commit}\`（${source.commitDate}）`)
  lines.push(
    `- 仓库许可：${source.license}，全文随包分发于 \`${licenseCopies.find((copy) => copy.collection === source.collection)?.path}\``
  )
  lines.push('')
}
lines.push('## 逐个技能的来源与署名')
lines.push('')
lines.push(
  '`本地 id` 一般就是作者在 SKILL.md 里写的 `name`。标「已加前缀」的，是因为那个名字已被我们自己的内置技能占用，'
)
lines.push('引入时给目录名与该文件的 `name:` 一起加了集合前缀 —— 除此之外没有改动，署名不变。')
lines.push('')
lines.push('| 本地 id | 来源仓库内路径 | 原作者 | 许可 | 备注 |')
lines.push('| --- | --- | --- | --- | --- |')
for (const row of attributionRows.sort((a, b) => a.id.localeCompare(b.id))) {
  lines.push(
    `| \`${row.id}\` | \`${row.relativePath}\` | ${row.author} | ${row.license} | ${row.renamed ? '已加前缀' : ''} |`
  )
}
lines.push('')
lines.push('## 未引入的技能（及原因）')
lines.push('')
lines.push(
  '按「许可不明的技能不进入发行包」这条 fail-closed 规则，下列技能**没有**引入。它们仍在来源仓库里，需要作者澄清或单独授权后再考虑：'
)
lines.push('')
lines.push('| 来源仓库内路径 | 声明的许可 | 原因 |')
lines.push('| --- | --- | --- |')
for (const row of excludedRows.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
  lines.push(
    `| \`${row.relativePath}\` | ${row.license === '' ? '(未声明)' : row.license} | ${row.reason} |`
  )
}
lines.push('')
await writeFile(join(skillsRoot, 'ATTRIBUTION.md'), lines.join('\n'))

console.log(
  JSON.stringify(
    {
      imported: importedIds.length,
      renamed: renames,
      excluded: excludedRows.length,
      byCollection: sources.map((source) => ({
        collection: source.collection,
        imported: attributionRows.filter((row) => row.collection === source.collection).length
      })),
      licenses: licenseCopies,
      excludedSample: excludedRows.map(
        (row) => `${row.relativePath} :: ${row.license || '(未声明)'}`
      )
    },
    null,
    2
  )
)
