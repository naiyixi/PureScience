// The input pre-check notice: what the task asks for, what is actually there, and that the notice rides
// in the provider content rather than in the user's own message.
//
// Path expectations go through node:path so this holds on Windows too — a POSIX literal like
// '/work/run1/x.csv' fails there, which is exactly how this file first went red.
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createInputNoticeResolver } from './input-notice'

describe('input notice resolver', () => {
  it('names the inputs a task references that do not exist', () => {
    const cwd = join('work', 'run1')
    const resolver = createInputNoticeResolver((path) => path.endsWith(join('data', 'params.json')))

    const notice = resolver.forTurn('分析 sim_a.csv 与 sim_b.csv，参数见 data/params.json', cwd)

    expect(notice).toContain('<missing_inputs>')
    expect(notice).toContain('sim_a.csv')
    expect(notice).toContain('sim_b.csv')
    // The one input that exists is not reported as missing.
    expect(notice).not.toContain('data/params.json')
  })

  it('says nothing when every input it can see is present', () => {
    const resolver = createInputNoticeResolver(() => true)

    expect(resolver.forTurn('分析 sim_a.csv 与 data/params.json', join('work'))).toBe('')
  })

  it('resolves a relative input against the session working directory', () => {
    const cwd = join('work', 'run2')
    const seen: string[] = []
    const resolver = createInputNoticeResolver((path) => {
      seen.push(path)
      return true
    })

    resolver.forTurn('用 counts.csv', cwd)

    expect(seen).toEqual([join(cwd, 'counts.csv')])
  })

  it('resolves an absolute input as written and a home-relative one against the home directory', () => {
    const seen: string[] = []
    const resolver = createInputNoticeResolver((path) => {
      seen.push(path)
      return true
    })

    resolver.forTurn('读 /mnt/raw/x.h5 和 ~/refs/1abc.pdb', join('work'))

    expect(seen[0]).toBe('/mnt/raw/x.h5')
    expect(seen[1]).toBe(join(homedir(), 'refs', '1abc.pdb'))
    expect(isAbsolute(seen[1] ?? '')).toBe(true)
  })
})
