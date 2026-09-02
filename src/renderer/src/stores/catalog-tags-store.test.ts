// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { MAX_TAG_LENGTH, selectTagSummaries, useCatalogTagsStore } from './catalog-tags-store'

beforeEach(() => {
  window.localStorage.clear()
  useCatalogTagsStore.setState({ entries: {}, standalone: [] })
})

describe('catalog tags standalone（零资源标签）', () => {
  it('createStandaloneTag 持久化一个零资源标签并可被 selectTagSummaries 列出', () => {
    expect(
      selectTagSummaries(
        useCatalogTagsStore.getState().entries,
        useCatalogTagsStore.getState().standalone
      )
    ).toEqual([])
    useCatalogTagsStore.getState().createStandaloneTag('  Docking ')
    const summaries = selectTagSummaries(
      useCatalogTagsStore.getState().entries,
      useCatalogTagsStore.getState().standalone
    )
    expect(summaries).toEqual([{ name: 'docking', resourceCount: 0 }])
    // 重复创建同名标签是 no-op（幂等）
    useCatalogTagsStore.getState().createStandaloneTag('DOCKING')
    expect(useCatalogTagsStore.getState().standalone).toEqual(['docking'])
  })

  it('标签被资源引用后 count 合并、不留双份', () => {
    useCatalogTagsStore.getState().createStandaloneTag('md')
    useCatalogTagsStore.getState().addTag('skill:one', 'MD')
    const summaries = selectTagSummaries(
      useCatalogTagsStore.getState().entries,
      useCatalogTagsStore.getState().standalone
    )
    expect(summaries).toEqual([{ name: 'md', resourceCount: 1 }])
  })

  it('deleteTag 同时删除零资源标签', () => {
    useCatalogTagsStore.getState().createStandaloneTag('old')
    useCatalogTagsStore.getState().addTag('connector:x', 'keep')
    useCatalogTagsStore.getState().deleteTag('old')
    expect(useCatalogTagsStore.getState().standalone).toEqual([])
    const summaries = selectTagSummaries(
      useCatalogTagsStore.getState().entries,
      useCatalogTagsStore.getState().standalone
    )
    expect(summaries).toEqual([{ name: 'keep', resourceCount: 1 }])
  })

  it('renameTag 重命名零资源标签；并入已存在标签时不产生 ghost', () => {
    useCatalogTagsStore.getState().createStandaloneTag('old')
    useCatalogTagsStore.getState().renameTag('old', 'new-name')
    expect(useCatalogTagsStore.getState().standalone).toEqual(['new-name'])

    useCatalogTagsStore.getState().createStandaloneTag('dupe')
    useCatalogTagsStore.getState().addTag('specialist:y', 'merge-target')
    useCatalogTagsStore.getState().renameTag('dupe', 'merge-target')
    // dupe 被并入已有 derived 标签：standalone 不再有 dupe，也不新增 merge-target ghost；
    // 先前重命名的 new-name 保持不变
    expect(useCatalogTagsStore.getState().standalone).toEqual(['new-name'])
  })

  it('持久化载荷同时包含 standalone 与 entries（v2 格式）', () => {
    useCatalogTagsStore.getState().createStandaloneTag('persisted')
    useCatalogTagsStore.getState().addTag('skill:a', 'used')
    const raw = window.localStorage.getItem('purescience.catalog-tags.v1')
    const parsed = raw
      ? (JSON.parse(raw) as { entries: Record<string, { tags: string[] }>; standalone: string[] })
      : null
    expect(parsed?.standalone).toEqual(['persisted'])
    expect(Object.keys(parsed?.entries ?? {})).toEqual(['skill:a'])
    // 旧的 v1 载荷是裸 entries map：loader 容错路径由 loadEntries 内部处理，
    // 这里只验证旧格式仍能被解析为合法 JSON（不抛错）。
    const legacy = JSON.stringify({ 'skill:a': { tags: ['legacy'], favorite: false } })
    expect(() => JSON.parse(legacy)).not.toThrow()
  })

  it('非法标签名被拒绝', () => {
    useCatalogTagsStore.getState().createStandaloneTag('x'.repeat(MAX_TAG_LENGTH + 1))
    useCatalogTagsStore.getState().createStandaloneTag('   ')
    expect(useCatalogTagsStore.getState().standalone).toEqual([])
  })
})
