// One producer for the OS notification, and it is the wired one.
//
// The defect this pins: two main-process modules posted a banner for the same turn end. One was the
// task-notification service (settings gate, focus gate, click-to-open, unread record, canonical English
// title), the other a side call from the turn workflow that bypassed all three: it fired while the app
// was focused, fired after the user had switched notifications off, fired in a headless --serve daemon
// that has no desktop to notify, and its body was authored in one language only. Two implementations of
// the same sentence is how the weaker one survives review.
//
// Reading the sources rather than rendering: the failing shape is "a second module constructs a
// Notification", which no behavioural test of either module can see. Both directions are pinned — no
// constructor outside the one delivery callback, and the one delivery callback is still reached from
// the runtime event stream (removing the duplicate must not leave the product with no producer at all).
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const mainRoot = fileURLToPath(new URL('..', import.meta.url))

const walkSource = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkSource(full, out)
    else if (/\.ts$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

// Comments explain the rule and are allowed to name the thing that was removed, so the scan reads code.
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const sources = walkSource(mainRoot).map((file) => ({
  file: relative(mainRoot, file),
  text: stripComments(readFileSync(file, 'utf8'))
}))

// Either literal constructor counts: the delivery callback takes the constructor as a dependency.
const CONSTRUCTS_NOTIFICATION = /new\s+(?:deps\.)?notificationCtor\s*\(|new\s+Notification\s*\(/i

describe('the OS notification has exactly one producer', () => {
  it('read the whole main tree (a scan that silently read nothing would prove nothing)', () => {
    expect(sources.length).toBeGreaterThan(200)
    expect(sources.some((source) => source.file === 'notifications/electron-wiring.ts')).toBe(true)
  })

  it('constructs it only in the delivery callback that the service injects', () => {
    const builders = sources
      .filter((source) => CONSTRUCTS_NOTIFICATION.test(source.text))
      .map((source) => source.file)

    expect(builders).toEqual(['notifications/electron-wiring.ts'])
  })

  it('keeps the headless gate in that one callback', () => {
    const wiring = sources.find((source) => source.file === 'notifications/electron-wiring.ts')

    expect(wiring).toBeDefined()
    // A daemon has no desktop user to banner; a producer without this line is the defect returning.
    expect(wiring?.text).toContain('if (deps.headless) return')
    expect(wiring?.text).toContain('isSupported()')
  })

  it('keeps the surviving producer wired to the runtime event stream', () => {
    const composition = sources.find((source) => source.file === 'acp/runtime-composition.ts')

    expect(composition).toBeDefined()
    expect(composition?.text).toContain('taskNotifications.handleRuntimeEvent(event)')
    expect(composition?.text).toContain('taskNotifications.handlePermissionRequest(request)')
  })

  it('leaves no second notification module behind', () => {
    const stragglers = sources.filter(
      (source) =>
        source.text.includes('turn-notifications') || source.text.includes('notifyTurnOutcome')
    )

    expect(stragglers.map((source) => source.file)).toEqual([])
  })
})
