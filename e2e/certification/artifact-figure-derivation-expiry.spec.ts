import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, receiptText, sendPrompt } from './helpers'

test.setTimeout(240_000)

// U4-f 的真窗口读数：换了输入、换了模型版本之后，旧的那条派生结果必须在溯源面上被标成过期，
// 而没有被推翻的那条**不被**标 —— 判决在主进程按会话的整本日志算好，页面只负责照实说。
//
// 判决依据的两样东西（输入指纹 / 模型版本）都由记录点写进 `.structure-observations/<sessionId>.json`，
// 所以这里像 readings 那支 spec 一样，把日志种在应用自己解析出的数据根上：读投影、算判决、渲染徽标
// 这三段都走生产代码，种进去的只是「会话当时录了什么」。
test('the provenance panel marks a derivation superseded, and leaves the current one unmarked', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  // configureFakeAgent 会重启应用并返回**新的** page：丢掉它就会拿着已关闭的旧 page 继续操作。
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Figure derivation expiry evidence')
  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )

  const receipt = await receiptText(page.getByText(/^Artifact provenance verified for session /))
  const identity = receipt.match(
    /^Artifact provenance verified for session ([^,]+), artifact ([^,]+), version ([^.]+)\.$/
  )
  if (!identity) throw new Error(`Invalid Artifact provenance receipt: ${receipt}`)
  const appSessionId = identity[1]

  // 数据根由应用自己解析（配置根 ≠ 数据根），所以问它，而不是照目录名猜。
  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
    }
    return (await bridge.api.storage.getInfo()).dataRoot
  })
  console.log(`[figure-expiry] dataRoot under test: ${dataRoot} (project ${projectId})`)

  const sha = (char: string): string => `sha256:${char.repeat(64)}`
  const bbox = { x: 40, y: 60, width: 180, height: 120 }
  const numbersDerivation = {
    kind: 'numbers' as const,
    source: 'pdf-text-in-bbox' as const,
    values: [{ value: '42', line: 'IC50 = 42 nM', bbox }]
  }
  const structureDerivation = (
    revision: string
  ): {
    kind: 'structure'
    source: 'ocsr'
    smiles: string
    canonical: string
    engines: { engine: string; revision: string }[]
    recognitionFingerprint: string
  } => ({
    kind: 'structure' as const,
    source: 'ocsr' as const,
    smiles: 'CCO',
    canonical: 'CCO',
    engines: [{ engine: 'decimer', revision }],
    recognitionFingerprint: sha('d')
  })

  const before = (minutesAgo: number): string =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString()

  await mkdir(join(dataRoot, '.structure-observations'), { recursive: true })
  await writeFile(
    join(dataRoot, '.structure-observations', `${appSessionId}.json`),
    JSON.stringify({
      dropped: 0,
      entries: [
        // ① 窗口内、被「后来换了输入的那一次」推翻 ⇒ 应当标过期（input-changed）。
        {
          recordedAt: before(60),
          kind: 'figure-derivation',
          figureDerivation: {
            page: 3,
            index: 2,
            bbox,
            figureClass: 'chart',
            inputFingerprint: sha('1'),
            derivation: numbersDerivation
          }
        },
        // ② 同一张图的另一次派生（改过图注 ⇒ 换了输入）：落在版本写出之后，因此不在窗口内显示，
        //    但**必须**参与判决 —— 按窗口算会把它当成不存在，① 就会被错判成 current。
        {
          recordedAt: new Date().toISOString(),
          kind: 'figure-derivation',
          figureDerivation: {
            page: 3,
            index: 2,
            bbox: { ...bbox, width: 200 },
            figureClass: 'chart',
            inputFingerprint: sha('2'),
            derivation: numbersDerivation
          }
        },
        // ③ 窗口内、输入没变但模型版本换了 ⇒ 应当标过期（model-revision-changed）。
        {
          recordedAt: before(50),
          kind: 'figure-derivation',
          figureDerivation: {
            page: 4,
            index: 1,
            bbox,
            figureClass: 'chemical-structure',
            inputFingerprint: sha('3'),
            modelRevision: 'decimer@1.0.0',
            derivation: structureDerivation('1.0.0')
          }
        },
        // ④ 与 ③ 同一份输入、换了一台引擎的版本（同图同框，指纹相同）。
        {
          recordedAt: new Date().toISOString(),
          kind: 'figure-derivation',
          figureDerivation: {
            page: 4,
            index: 1,
            bbox,
            figureClass: 'chemical-structure',
            inputFingerprint: sha('3'),
            modelRevision: 'decimer@1.1.0',
            derivation: structureDerivation('1.1.0')
          }
        },
        // ⑤ 窗口内、这张图再没有被派生过 ⇒ 仍是 current：它**不许**出现徽标。
        {
          recordedAt: before(40),
          kind: 'figure-derivation',
          figureDerivation: {
            page: 5,
            index: 1,
            bbox,
            figureClass: 'chart',
            inputFingerprint: sha('4'),
            derivation: numbersDerivation
          }
        }
      ]
    }),
    'utf8'
  )

  await page
    .getByRole('button', { name: /^Preview generated file provenance-evidence\.txt$/ })
    .first()
    .click()
  await expect(page.getByTestId('preview-card')).toBeVisible()
  await page
    .getByRole('button', { name: /^File actions for / })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Provenance' }).click()
  await expect(page.getByTestId('artifact-provenance')).toBeVisible()

  await page.getByRole('tab', { name: 'Structure context' }).click()
  const list = page.getByTestId('artifact-structure-observations-list')
  await expect(list).toBeVisible()
  // 窗口内三条（①③⑤）；②④ 在窗口外，由「later」计数如实报出来 —— 它们的缺席本身就是窗口的承诺。
  // 只数顶层的行：派生结果的数值那一块自己是 `<ul><li>`，用后代选择器会把它们一起数进来（实测 3 行数成 6）。
  await expect(list.locator('> li')).toHaveCount(3)
  await expect(page.getByTestId('artifact-structure-observations-after-window')).toContainText(
    '2 recorded after this Version'
  )

  const badges = page.getByTestId('artifact-figure-observations-superseded')
  await expect(badges).toHaveCount(2)
  const texts = await badges.allInnerTexts()
  console.log(`[figure-expiry] superseded badges: ${JSON.stringify(texts)}`)
  expect(texts.some((text) => text.includes('different input'))).toBe(true)
  expect(texts.some((text) => text.includes('different model revision'))).toBe(true)
  // 原因句带上取代那一条的录制时刻，读的人据此去找它。
  expect(texts.some((text) => text.includes('different model revision (2'))).toBe(true)

  // ⑤ 那一行没有任何徽标：不是「刚好没渲染」，而是它确实被判决为 current。
  const currentRow = list.locator('> li').filter({ hasText: 'page 5' })
  await expect(currentRow).toHaveCount(1)
  await expect(currentRow.getByTestId('artifact-figure-observations-superseded')).toHaveCount(0)
})
