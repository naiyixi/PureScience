// Prints the git pathspecs that the brand scan must skip: the third-party skills we redistribute verbatim.
//
// Why they are exempt: our own copy and UI must not borrow another product's terminology, but a skill we ship
// under its author's license keeps the author's words — their READMEs name their own tools, and 2.3's rule is
// that attribution and content stay as written. Rewriting them would be both a licensing question and a lie
// about what the file says. The exemption is therefore narrow and derived from the manifest, never a hand list:
// only directories listed as `thirdParty` rows, plus the attribution file and the license texts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const manifest = JSON.parse(
  readFileSync(join(root, 'resources', 'skills', 'manifest.json'), 'utf8')
)

const paths = manifest.skills
  .filter((skill) => skill.thirdParty !== undefined)
  .map((skill) => `:(exclude)resources/skills/${skill.id}`)

paths.push(':(exclude)resources/skills/ATTRIBUTION.md')
paths.push(':(exclude)resources/skills/licenses')
// The two files whose whole job is naming the source repository and its commit.
paths.push(':(exclude)resources/skills/manifest.json')
paths.push(':(exclude)scripts/third-party-skills.sources.json')
process.stdout.write(`${paths.join('\n')}\n`)
