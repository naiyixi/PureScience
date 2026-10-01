import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Workflow = {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  on?: {
    push?: { branches?: string[]; 'paths-ignore'?: string[] }
    schedule?: unknown
    workflow_dispatch?: unknown
  }
}

const nightly = load(
  readFileSync(join(process.cwd(), '.github/workflows/nightly.yml'), 'utf8')
) as Workflow

describe('Nightly workflow', () => {
  it('keeps a dispatched verification from being cancelled by a later push', () => {
    // A push superseding another push is right: a stale nightly is not worth finishing. A DISPATCH is a
    // different intent — "verify this head and let it finish" — and it is the only determinate way to get a
    // clean verdict before a release decision when work is still being pushed. Sharing the push's group
    // would make that request cancellable by the very pushes it is meant to be independent of.
    expect(nightly.concurrency?.group).toContain('github.event_name')
    // Cost stays bounded in the other direction: pushes still cut each other short.
    expect(nightly.concurrency?.['cancel-in-progress']).toBe(true)
  })

  it('stays runnable on demand', () => {
    expect(nightly.on).toHaveProperty('workflow_dispatch')
  })

  it('still skips docs-only pushes', () => {
    expect(nightly.on?.push?.branches).toContain('main')
    expect(nightly.on?.push?.['paths-ignore']).toContain('**/*.md')
  })
})
