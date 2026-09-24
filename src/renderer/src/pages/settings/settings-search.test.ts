import { describe, expect, it } from 'vitest'

import { matchesSettingsQuery } from './settings-panel-search'

// The audit asked for a query a user would actually type — the download source — to reach the panel that
// owns it, even though that panel is called "Network". These panels mirror the real keyword sets.
const panels = [
  {
    id: 'network',
    label: 'Network',
    keywords: ['proxy', 'mirror', 'registry', 'npm', '镜像', '代理']
  },
  { id: 'runtimes', label: 'Runtimes', keywords: ['python', 'environment', 'mirror', '运行环境'] },
  { id: 'storage', label: 'Storage', keywords: ['data root', 'disk', '存储'] },
  { id: 'general', label: 'General', keywords: ['language', 'theme', '语言'] }
]

const idsFor = (query: string): string[] =>
  panels.filter((panel) => matchesSettingsQuery(panel, query)).map((panel) => panel.id)

describe('settings search', () => {
  it('reaches a panel by what it does, not only by what it is called', () => {
    expect(idsFor('mirror')).toEqual(['network', 'runtimes'])
    expect(idsFor('代理')).toEqual(['network'])
    expect(idsFor('data root')).toEqual(['storage'])
    expect(idsFor('语言')).toEqual(['general'])
  })

  it('still answers the labelled name and the stable id, case-insensitively', () => {
    expect(idsFor('storage')).toEqual(['storage'])
    expect(idsFor('NETWORK')).toEqual(['network'])
    expect(idsFor('run')).toEqual(['runtimes'])
  })

  it('shows everything before anything is typed, and nothing for a query no panel answers', () => {
    expect(idsFor('')).toEqual(['network', 'runtimes', 'storage', 'general'])
    expect(idsFor('zzzz-no-such-panel')).toEqual([])
  })
})
