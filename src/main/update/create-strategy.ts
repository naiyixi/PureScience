import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

import { app } from 'electron'

import { createLogger } from '../logger'
import { ElectronUpdaterStrategy } from './electron-updater-strategy'
import { UpdateService } from './service'
import type { InstallGate, UpdateStrategy } from './strategy'

export type CreateStrategyOptions = {
  // Whether this is a packaged (installed) build. Defaults to app.isPackaged; injectable for tests.
  isPackaged?: boolean
  // Running app version. Defaults to app.getVersion(); injectable for tests.
  version?: string
  // Immutable pre-install backend shutdown gate for in-place strategies. The manual installer flow
  // ignores it because applying there does not quit or replace the running app.
  installGate?: InstallGate
}

// Certification switch for the manifest installer flow. A Developer-ID-signed stable mac build is routed
// to the in-place updater (see macCanAutoUpdate), so the installer flow — still what nightly and ad-hoc
// builds ship, and the fallback whenever the installed signature cannot be attributed — can no longer
// reach a window on the stable release lane. Its end-to-end certification therefore asks for it by name.
// Only the exact value `installer` is honoured; anything else (including unset) keeps the default policy.
export const UPDATE_FLOW_ENV = 'PURESCIENCE_UPDATE_FLOW'

const installerFlowRequested = (): boolean =>
  (process.env[UPDATE_FLOW_ENV] ?? '').trim() === 'installer'

const OFFICIAL_MAC_BUNDLE_ID = 'com.zerolink.purescience'

// A stable mac build may only be updated in place when this machine can prove the installed bundle and
// the replacement carry the same Team signature. That Team is our own Developer ID, passed in at
// package time; an unset variable means "not provisioned yet" and must fail closed to the manual
// installer rather than trust some other publisher's identity.
declare const __PURESCIENCE_MAC_TEAM_ID__: string

const expectedMacTeamId = (): string => {
  const fromEnvironment = process.env.PURESCIENCE_MAC_TEAM_ID
  // Defined-but-empty means "pretend nothing is provisioned": the packaged build carries a baked Team ID
  // now, and the certification specs for the manual installer need a launch where in-place is refused.
  if (fromEnvironment !== undefined) return fromEnvironment.trim()
  return bakedMacTeamId()
}

// `electron.vite.config.ts` replaces this identifier with the value present at package time. Packaged apps
// launched from Finder have no environment, so without the baked copy the gate could never pass in the field.
const bakedMacTeamId = (): string =>
  typeof __PURESCIENCE_MAC_TEAM_ID__ === 'string' ? __PURESCIENCE_MAC_TEAM_ID__ : ''

// Read the installed bundle's signing metadata without performing a trust evaluation. The latter can
// depend on machine policy/keychain state, while Squirrel.Mac only needs the current and replacement
// bundles to carry compatible designated requirements. Stable CI releases are signed by this bundle
// ID + Team ID; local packages are ad-hoc signed and report no TeamIdentifier.
const hasExpectedMacSignature = (expectedTeamId: string): boolean => {
  if (!expectedTeamId) return false
  const bundlePath = resolve(dirname(app.getPath('exe')), '../..')
  const result = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', bundlePath], {
    encoding: 'utf8'
  })
  if (result.status !== 0) return false

  const details = new Set(`${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/))
  return (
    details.has(`Identifier=${OFFICIAL_MAC_BUNDLE_ID}`) &&
    details.has(`TeamIdentifier=${expectedTeamId}`)
  )
}

// macOS in-place auto-update (electron-updater / Squirrel.Mac) only works on a packaged build that is
// signed with the same Developer ID as the replacement. Our own Team ID is provisioned at package time;
// local packages and nightlies are ad-hoc, so ShipIt rejects an official replacement at apply time.
// Check the actual installed signature rather than inferring it from the version, and fail closed to
// the manual installer flow whenever compatibility cannot be established.
const macCanAutoUpdate = (
  isPackaged: boolean,
  version: string,
  expectedTeamId: string = expectedMacTeamId()
): boolean => isPackaged && !version.includes('-') && hasExpectedMacSignature(expectedTeamId)

// Picks the update strategy for the host platform. Windows/Linux always get true in-place auto-update
// via electron-updater. macOS gets it too on signed stable builds (see macCanAutoUpdate); otherwise
// (dev, nightly, or any other platform) it falls back to the manifest installer flow (UpdateService).
export const createUpdateStrategy = (
  platform: NodeJS.Platform = process.platform,
  opts: CreateStrategyOptions = {}
): UpdateStrategy => {
  const log = createLogger('update')
  const createInPlaceStrategy = (): ElectronUpdaterStrategy =>
    new ElectronUpdaterStrategy({
      ...(opts.installGate ? { installGate: opts.installGate } : {}),
      log
    })

  if (platform === 'win32' || platform === 'linux') return createInPlaceStrategy()

  // Named request wins over the signature probe (darwin only — the win/linux lanes certify the in-place
  // updater itself): asking for the installer flow must not depend on what this bundle happens to be
  // signed with, or the certification lane could not exercise it at all.
  if (installerFlowRequested()) {
    log.info('installer update flow requested', {
      operation: 'update-strategy',
      reason: 'installer-flow-requested'
    })
    return new UpdateService({ log })
  }

  const isPackaged = opts.isPackaged ?? app?.isPackaged ?? false
  const version = opts.version ?? app?.getVersion?.() ?? '0.0.0'
  if (platform === 'darwin' && macCanAutoUpdate(isPackaged, version)) {
    return createInPlaceStrategy()
  }
  // Name the gap instead of leaving a packaged mac user wondering why every update is a manual
  // reinstall: an unprovisioned Team ID is the reason, and it is our reason, not theirs.
  if (platform === 'darwin' && isPackaged && !version.includes('-') && expectedMacTeamId() === '') {
    log.info('in-place update not offered', {
      operation: 'update-strategy',
      reason: 'mac-team-id-not-provisioned'
    })
  }
  return new UpdateService({ log })
}
