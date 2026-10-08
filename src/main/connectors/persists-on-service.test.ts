// The set of tools that declare they leave something behind on the service is pinned ON PURPOSE.
//
// The marker drives a line on the approval card. A wrong entry teaches the user to ignore the line and a
// missing one hides a consequence, so the declaring set is asserted against the descriptors' own source
// rather than trusted — and the one declaration is tied to the request that actually creates state.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'src/main/connectors/descriptors')
const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort()
const source = (name: string): string => readFileSync(join(DIR, name), 'utf8')

describe('tools that leave something behind on the service declare it', () => {
  it('declares it for exactly one tool — the one whose code creates state there', () => {
    const declaring = files.filter((name) => source(name).includes('persistsOnService: true'))
    expect(declaring).toEqual(['genes-enrichr.ts'])

    // The declaration has to match the behaviour, or it drifts into a claim about nothing: this tool is
    // the one that POSTs the gene list to the service, which hands back an id later requests address.
    const enrichr = source('genes-enrichr.ts')
    expect(enrichr).toContain('Enrichr/addList')
    expect(enrichr).toContain("method: 'POST'")
    expect(enrichr).toContain('userListId')
  })

  it('leaves the POST-as-query tools unmarked, so the line keeps its meaning', () => {
    // A POST that only carries a query is a read — most POST-only APIs here are GraphQL or /fetch
    // endpoints. Naming a few of them keeps the guard honest in both directions.
    for (const name of [
      'variants-gnomad.ts',
      'genes-proteins.ts',
      'structures-pdb.ts',
      'clinical-genomics.ts'
    ]) {
      expect(source(name), `${name} should still be a POST-as-query tool`).toContain('postJson')
      expect(source(name), `${name} must not declare persistence`).not.toContain(
        'persistsOnService: true'
      )
    }
  })

  it('keeps the field optional on the descriptor contract', () => {
    const types = readFileSync(join(process.cwd(), 'src/main/connectors/types.ts'), 'utf8')
    expect(types).toContain('persistsOnService?: boolean')
  })
})
