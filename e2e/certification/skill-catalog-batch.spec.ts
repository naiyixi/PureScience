import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// The bundled skill batch has to be there in a real window, not just in resources/: the manifest can list a
// skill whose SKILL.md is missing and the panel would silently drop it. So this asks the app's own catalog
// (settings.listSkills) for each new id, and then reads one body back to prove the text shipped too.
test.setTimeout(180_000)

const BATCH = [
  'survival-and-competing-risk',
  'diagnostic-accuracy',
  'sample-size-power',
  'real-world-evidence',
  'mendelian-randomization',
  'systematic-review-meta',
  'clinical-data-deidentification',
  'missing-data-handling',
  'grant-proposal-audit'
] as const

test('the new skill batch is in the catalog a real window sees, and its text is readable', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.restart()

  const catalog = (await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { settings: { listSkills: () => Promise<unknown> } }
    }
    return bridge.api.settings.listSkills()
  })) as Array<Record<string, unknown>>

  const ids = catalog.map((item) => String(item.id ?? item.slug ?? item.name ?? ''))
  console.log(`[skill-batch] catalog size: ${catalog.length}`)
  const missing = BATCH.filter((id) => !ids.includes(id))
  console.log(`[skill-batch] missing: ${missing.length === 0 ? 'none' : missing.join(', ')}`)
  expect(missing).toEqual([])

  // Names must be the Chinese display names, not the slugs: the panel shows `name`.
  const names = catalog
    .filter((item) => BATCH.includes(String(item.id) as (typeof BATCH)[number]))
    .map((item) => String(item.name))
  console.log(`[skill-batch] names: ${names.join(' / ')}`)
  expect(names.some((name) => /[\u4e00-\u9fa5]/.test(name))).toBe(true)

  const detail = (await page.evaluate(async (id: string) => {
    const bridge = globalThis as unknown as {
      api: { settings: { getSkillDetail: (id: string) => Promise<{ body?: string }> } }
    }
    return bridge.api.settings.getSkillDetail(id)
  }, 'survival-and-competing-risk')) as { body?: string }

  const body = detail.body ?? ''
  console.log(`[skill-batch] body length: ${body.length}`)
  // The body has to be the procedure it claims to be, not a stub.
  expect(body.length).toBeGreaterThan(1000)
  expect(body).toContain('常见失败')
  expect(body).toContain('竞争')
})
