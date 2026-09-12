// The input pre-check notice: what the task asks for, what is actually there, and that the notice rides
// in the provider content rather than in the user's own message.
import { describe, expect, it } from 'vitest'

import { createInputNoticeResolver } from './input-notice'

describe('input notice resolver', () => {
  it('names the inputs a task references that do not exist', () => {
    const resolver = createInputNoticeResolver((path) => path.endsWith('data/params.json'))

    const notice = resolver.forTurn(
      '分析 sim_a.csv 与 sim_b.csv，参数见 data/params.json',
      '/work/run1'
    )

    expect(notice).toContain('<missing_inputs>')
    expect(notice).toContain('sim_a.csv')
    expect(notice).toContain('sim_b.csv')
    // The one input that exists is not reported as missing.
    expect(notice).not.toContain('data/params.json')
  })

  it('says nothing when every input it can see is present', () => {
    const resolver = createInputNoticeResolver(() => true)

    expect(resolver.forTurn('分析 sim_a.csv 与 data/params.json', '/work')).toBe('')
  })

  it('resolves a relative input against the session working directory', () => {
    const seen: string[] = []
    const resolver = createInputNoticeResolver((path) => {
      seen.push(path)
      return true
    })

    resolver.forTurn('用 counts.csv', '/work/run2')

    expect(seen).toEqual(['/work/run2/counts.csv'])
  })

  it('resolves an absolute input as written and a home-relative one against the home directory', () => {
    const seen: string[] = []
    const resolver = createInputNoticeResolver((path) => {
      seen.push(path)
      return true
    })

    resolver.forTurn('读 /mnt/raw/x.h5 和 ~/refs/1abc.pdb', '/work')

    expect(seen[0]).toBe('/mnt/raw/x.h5')
    expect(seen[1]).toMatch(/\/refs\/1abc\.pdb$/)
    expect(seen[1]?.startsWith('/')).toBe(true)
  })
})
