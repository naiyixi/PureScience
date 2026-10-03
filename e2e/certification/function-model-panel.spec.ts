import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Guard for a defect class the user hit on the real window (2026-10-03): the function-model panel rendered
// "this window cannot read the function-model settings" with inert buttons. Asked directly, the window
// answered `No handler registered for 'settings:function-models'` — the channel existed as an APPLICATION
// COMMAND (the local-web/CLI surface) and the window called it, but nothing served it on the ELECTRON bus.
// Two siblings were dead the same way (`settings:skill-availability`, `settings:execution-protection`), so
// this is a class rather than an incident: a channel the renderer can call must be answerable on the surface
// that calls it.
//
// The assertions are on the CHANNEL, because that is what each panel's own read path uses: while the channel
// rejects, the panel can only ever show its "cannot read" sentence, whatever the UI otherwise looks like.

test.setTimeout(180_000)

// `path` is the member the window calls; `shape` names a field the answer must carry. An ack carrying no
// payload would make a registered-but-hollow handler look healthy.
const SURFACES: Array<{ label: string; path: string; args: unknown[]; shape?: string }> = [
  {
    label: 'function models (resolve)',
    path: 'settings.functionModels',
    args: [{ action: 'resolve', functionId: 'skill-selection' }],
    shape: 'models'
  },
  {
    label: 'function models (events)',
    path: 'settings.functionModels',
    args: [{ action: 'events' }],
    shape: 'events'
  },
  {
    label: 'skill availability',
    path: 'settings.skillAvailability',
    args: [{ action: 'get' }],
    shape: 'view'
  },
  {
    label: 'execution protection',
    path: 'settings.executionProtection',
    args: [{}],
    shape: 'matrix'
  },
  { label: 'egress settings', path: 'settings.getEgress', args: [] },
  { label: 'auto-apply', path: 'settings.getAutoApply', args: [] },
  { label: 'app icons', path: 'settings.listAppIcons', args: [] },
  { label: 'package mirror', path: 'settings.getPackageMirror', args: [] },
  { label: 'network info', path: 'network.getInfo', args: [], shape: 'connectionType' },
  { label: 'local file roots', path: 'localFs.getRoots', args: [], shape: 'home' },
  { label: 'folder grants', path: 'folderGrants.list', args: [], shape: 'grants' },
  { label: 'client id', path: 'lifecycle.getClientId', args: [] }
]

test('every settings channel the window calls is answered on the IPC bus', async ({ app }) => {
  const page = await app.completeOnboarding()
  await createProject(page, 'Channel answers')

  const readings = await page.evaluate(async (probes) => {
    const bridge = globalThis as unknown as { api?: Record<string, Record<string, unknown>> }
    const results: Array<{ label: string; ok: boolean; detail: string; keys: string[] }> = []
    for (const probe of probes) {
      const [capability, member] = probe.path.split('.')
      const fn = bridge.api?.[capability]?.[member]
      if (typeof fn !== 'function') {
        results.push({
          label: probe.label,
          ok: false,
          detail: `not callable (${typeof fn})`,
          keys: []
        })
        continue
      }
      try {
        const value = (await (fn as (...args: unknown[]) => Promise<unknown>)(
          ...probe.args
        )) as Record<string, unknown>
        results.push({
          label: probe.label,
          ok: true,
          detail: 'answered',
          keys: value === null || typeof value !== 'object' ? [] : Object.keys(value)
        })
      } catch (error) {
        results.push({
          label: probe.label,
          ok: false,
          // The whole rejection, so a renamed or unregistered channel names itself instead of reading as
          // "the panel is broken".
          detail: String(error).replace(/^Error: /, ''),
          keys: []
        })
      }
    }
    return results
  }, SURFACES)

  for (const reading of readings) {
    console.log(
      `[settings-channels] ${reading.ok ? 'OK  ' : 'DEAD'} ${reading.label}` +
        (reading.ok ? ` :: keys=${reading.keys.join(',') || '(none)'}` : ` :: ${reading.detail}`)
    )
  }

  const dead = readings.filter((reading) => !reading.ok)
  expect(dead.map((reading) => `${reading.label} :: ${reading.detail}`)).toEqual([])

  // The three that were dead must not merely answer — they must carry the field their panel reads.
  for (const probe of SURFACES.filter((entry) => entry.shape !== undefined)) {
    const reading = readings.find((entry) => entry.label === probe.label)
    expect(reading?.keys, `${probe.label} answered without '${probe.shape}'`).toContain(probe.shape)
  }
})
