import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// A source read rather than a behaviour test. Three remote operations raise an approval card
// (call_command, submit_job, session-cache download); each one must carry the protection level, and
// dropping it from any of them would make the card and the gate silently blind — the suite would stay
// green because nothing asserts on the wire shape of every site. The count is pinned so a fourth site
// has to be declared here (with its protection field) instead of slipping in unnoticed.
const APPROVAL_SITE_COUNT = 3

const approvalInfoBlocks = (): string[] => {
  const source = readFileSync(resolve(__dirname, 'compute-service.ts'), 'utf8')
  return [...source.matchAll(/const approvalInfo = \{[\s\S]*?\n\s*\}/g)].map((match) => match[0])
}

describe('compute approval sites carry protection evidence', () => {
  it('declares exactly the known approval sites', () => {
    expect(approvalInfoBlocks()).toHaveLength(APPROVAL_SITE_COUNT)
  })

  it('attaches a protection snapshot to every approval request', () => {
    const missing = approvalInfoBlocks().filter((block) => !block.includes('protection'))
    expect(missing).toEqual([])
  })
})
