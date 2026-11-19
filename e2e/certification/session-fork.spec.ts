import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// Acceptance for session forking on a real window: the reader measures the copy before anything is
// written, confirms, and ends up with a second session that holds the exchange without the source
// being touched.
//
// The two-step shape is the point, so it is asserted as two steps: the plan is visible (and the copy
// list is not written to yet — the sidebar still holds one session), then the confirm produces the
// copy (the sidebar holds two).

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Fork acceptance project')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

// Probing this on the packaged app found the real defect behind it: the card is re-mounted while it is
// open, and the fork plan a reader had just measured was living in component state, so a background
// session update discarded it (and a click that straddled the re-mount hit a replaced node). The plan
// is now kept per session, and the unit test beside the component pins that survival. This spec is the
// end-to-end half: a settled card, two steps, and a copy that appears in the session list.
test('measures a fork before copying it, then creates a session that holds the exchange', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  // One exchange, so the copy has something to hold.
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Summarise the calibration notes')
  await page.keyboard.press('Enter')
  // Wait for the exchange to actually land before touching the card. The composer being enabled is true
  // before the run starts as well, so it answers nothing here — measured on the packaged app: the card
  // opened while the conversation still carried its placeholder id (`pending-session-…`), a pending
  // conversation is not persisted at all, and the measure therefore answered "the source session could
  // not be read" until the durable id arrived a couple of seconds later. Two product-driven readings
  // instead: the reply is on screen, and the session carries its durable id.
  await expect(
    page.getByText('Deterministic reply: Summarize the deterministic fixture.')
  ).toBeVisible()
  const conversation = page.locator('section[data-session-id]')
  await expect(conversation).not.toHaveAttribute('data-session-id', /^pending-session-/)
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeEnabled()

  const sessions = page.getByRole('navigation', { name: 'Sessions' })
  const sessionRows = sessions.getByRole('button', { name: /Session status/ })
  await expect(sessionRows).toHaveCount(1)

  // The session's information card is where a fork starts.
  await page.getByTestId('conversation-title-button').click()
  await page.locator('[data-slot="session-info-card"]').waitFor({ state: 'visible' })
  await page.waitForTimeout(600)

  const forkAction = page.getByRole('button', { name: 'Fork session' })
  // The caution lives where a reader finds it before pressing: the action's own tooltip.
  await expect(forkAction).toHaveAttribute(
    'title',
    'Measure first: see what the copy would hold before creating it'
  )

  // Step one: measure. The numbers are shown, and nothing has been written yet.
  //
  // Press the way a hand does, and be willing to press again. Hovering the card re-renders its mount
  // site, and a press whose mousedown and mouseup straddle that re-render is delivered to a node the
  // renderer has already replaced — no click, nothing happens, exactly as if the press had missed. A
  // person who sees nothing happen presses again; so does this. (An instantaneous synthesised click
  // loses the press every time, which is how this spec first failed, and a single held press still lost
  // it on the CI runner — the retry is what makes the press dependable rather than lucky.)
  //
  // The same window can also leave nothing to press at all: a box measured while the node that had just
  // been resolved is replaced (or is briefly zero-sized) comes back `null`, and throwing there reports a
  // re-mount as a product failure. That is what happened on a loaded runner — `boundingBox()` was null
  // 400ms after a hover that had just succeeded, so the press was never even attempted. So the box is
  // waited for, every wait is said out loud in the log, and a press that still has no box is simply
  // another attempt (the loop below only ever stops on the outcome it is waiting for).
  // 到手一次的按压之外，还有一条确定性激活路径：让按钮拿到焦点，再按 Enter。键盘激活是真实用户
  // 路径（Tab 过去按回车），不依赖坐标，也不受视口尺寸与重挂载影响。为什么需要它：在 CI 的
  // macos-arm64 上这条用例连续两轮都是「悬停成功、box 有值、mousedown/mouseup 都发出去、预览不出现」，
  // 三次手按全无反应，同一提交在本机 12 秒通过。此时只报「没弹预览」分不清是没按到、还是按到了没生效，
  // 所以按压前先做一次命中测试，把命中到的东西写进日志；手按落空时不再重复猜，直接换键盘激活。
  // 断言一条没放宽：仍然是「预览出现 + 计数正确 + 源会话不动」，只是把「怎么按」这件事做实。
  const card = page.locator('[data-slot="session-info-card"]')
  const pressByHand = async (target: typeof forkAction, what: string): Promise<boolean> => {
    if (!(await card.isVisible().catch(() => false))) {
      console.log(
        `[session-fork] the card was off screen before pressing ${what}; opening it again`
      )
      await page.getByTestId('conversation-title-button').click()
      await card.waitFor({ state: 'visible' })
      await page.waitForTimeout(400)
    }
    await target.hover()
    await page.waitForTimeout(400)
    let box = await target.boundingBox()
    for (let wait = 0; wait < 10 && !box; wait += 1) {
      console.log(`[session-fork] the ${what} action has no box yet (wait ${wait + 1}/10)`)
      await page.waitForTimeout(200)
      box = await target.boundingBox()
    }
    if (!box) {
      console.log(`[session-fork] the ${what} action still has no box; pressing again`)
      return false
    }
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const hit = await page.evaluate(
      ([x, y]: [number, number]) => {
        const el = document.elementFromPoint(x, y)
        if (!el) return 'nothing (point is outside the viewport)'
        const slot = el.getAttribute('data-slot')
        const label = (el.textContent ?? '').trim().slice(0, 40)
        return `${el.tagName.toLowerCase()}${slot ? `[data-slot=${slot}]` : ''} "${label}"`
      },
      [cx, cy] as [number, number]
    )
    console.log(
      `[session-fork] pressing ${what} at ${Math.round(cx)},${Math.round(cy)} (box ${Math.round(box.width)}x${Math.round(box.height)}); the point resolves to ${hit}`
    )
    if (hit.startsWith('nothing')) {
      await target.scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      return false
    }
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.waitForTimeout(60)
    await page.mouse.up()
    return true
  }
  // 键盘激活：焦点在按钮上时按 Enter，与用手按回车等价，触发的是同一个 click。
  const pressByKeyboard = async (target: typeof forkAction, what: string): Promise<void> => {
    await target.focus()
    console.log(`[session-fork] pressing ${what} from the keyboard (focus + Enter)`)
    await page.keyboard.press('Enter')
  }
  const manifest = page.locator('[data-slot="session-fork-manifest"]')
  for (let attempt = 0; attempt < 3 && (await manifest.count()) === 0; attempt += 1) {
    if (attempt === 0) {
      const landed = await pressByHand(forkAction, 'fork')
      if (!landed) continue
    } else {
      await pressByKeyboard(forkAction, 'fork')
    }
    await page.waitForTimeout(500)
  }
  await expect(page.getByText('The copy will hold')).toBeVisible()
  await expect(page.getByText('Messages: 2')).toBeVisible()
  await expect(page.getByText('Agent replies: 1')).toBeVisible()
  await expect(page.getByText(/Not carried: /)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create the copy' })).toBeVisible()
  await expect(sessionRows).toHaveCount(1)

  // Step two: confirm. Now the copy exists as its own session, source untouched. The same press can be
  // lost to the same cause, so it is retried the same way — and the retry can only ever be another
  // press, never a silent second copy: the loop stops on the outcome it is waiting for.
  const created = page.getByText('The copy was created')
  const confirm = page.getByRole('button', { name: 'Create the copy' })
  for (let attempt = 0; attempt < 3 && (await created.count()) === 0; attempt += 1) {
    if (attempt === 0) {
      const landed = await pressByHand(confirm, 'create the copy')
      if (!landed) continue
    } else {
      await pressByKeyboard(confirm, 'create the copy')
    }
    await page.waitForTimeout(700)
  }
  await expect(created).toBeVisible()
  await expect(sessionRows).toHaveCount(2)
})
