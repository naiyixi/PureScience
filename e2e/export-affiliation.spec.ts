import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

// 机构字段的实机验收：真窗口、真 IPC、真 settings.json（隔离存储根），不做界面替身。
// 判据落在「关掉设置再重开还在」和「导出侧读到的就是那个值」两处 —— 只验输入框里有字不算数。
test('keeps the export affiliation across a settings reopen, and hands it to the export path', async ({
  app
}) => {
  let page = await app.completeOnboarding()

  const openSettings = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Model settings' }).click()
    await page
      .getByRole('dialog', { name: 'Settings' })
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('button', { name: 'General', exact: true })
      .click()
  }

  await openSettings()
  let settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByLabel('Author', { exact: true }).fill('Abel Wang')
  await settings.getByLabel('Institution', { exact: true }).fill('浙江大学医学院附属第二医院')

  // 关掉再重开：值来自磁盘而不是输入框自己的状态。
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await openSettings()
  settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByLabel('Author', { exact: true })).toHaveValue('Abel Wang')
  await expect(settings.getByLabel('Institution', { exact: true })).toHaveValue(
    '浙江大学医学院附属第二医院'
  )

  // 再重启整个应用：这一步才排除「只是渲染进程记着」。
  page = await app.restart()
  await openSettings()
  settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByLabel('Institution', { exact: true })).toHaveValue(
    '浙江大学医学院附属第二医院'
  )

  // 导出侧读到的是同一份设置（主进程的 loadAttribution 走的正是这个快照）。
  const snapshot = await page.evaluate(async () => {
    const api = (
      window as unknown as { api: { settings: { getSettings: () => Promise<unknown> } } }
    ).api
    return (await api.settings.getSettings()) as {
      exportAuthor?: string
      exportAuthorKind?: string
      exportAffiliation?: string
    }
  })
  expect(snapshot.exportAuthor).toBe('Abel Wang')
  expect(snapshot.exportAuthorKind).toBe('person')
  expect(snapshot.exportAffiliation).toBe('浙江大学医学院附属第二医院')

  // 类型切到「机构」时，同一栏的含义变成「上级单位」——提示要在真窗口里出现，
  // 否则用户会把自己单位再填一遍，导出里就多一个没有意义的 Organization。
  await settings.getByRole('combobox', { name: 'Author type' }).click()
  await page.getByRole('option', { name: 'Institution' }).click()
  await expect(
    settings.getByText('Parent organisation — optional; leave it empty if this publisher has none')
  ).toBeVisible()
})
