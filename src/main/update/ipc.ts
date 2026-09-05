import { ipcMainHandle } from '../ipc-handler-registry'

import { APP } from '../../shared/app-config'
import type { AppInfo, UpdateStatus } from '../../shared/update'
import { createUpdateStrategy } from './create-strategy'
import type { UpdateStrategy } from './strategy'

type UpdateCommandOwner = Readonly<{
  getAppInfo: () => AppInfo
  getStatus: () => UpdateStatus
  check: () => Promise<UpdateStatus>
  download: () => Promise<UpdateStatus>
  cancel: () => Promise<UpdateStatus>
  apply: () => Promise<UpdateStatus>
}>

export type UpdateCommandOptions = {
  // When an in-place (restart-kind) download completes and this resolves true, apply the update
  // automatically instead of waiting for the user's click — the Settings → General auto-apply
  // opt-in (absent = never auto-apply). The installer (mac manual) kind is never auto-applied.
  isAutoApplyEnabled?: () => Promise<boolean>
}

const createUpdateCommandOwner = (
  strategy: UpdateStrategy,
  options: UpdateCommandOptions = {}
): UpdateCommandOwner => {
  const applyIfAutoRequested = async (next: UpdateStatus): Promise<UpdateStatus> => {
    if (
      next.state === 'ready' &&
      next.applyKind === 'restart' &&
      options.isAutoApplyEnabled &&
      (await options.isAutoApplyEnabled())
    ) {
      return strategy.apply()
    }
    return next
  }

  return {
    getAppInfo: (): AppInfo => ({
      name: APP.name,
      version: strategy.getStatus().current,
      copyright: APP.copyright
    }),
    getStatus: () => strategy.getStatus(),
    check: () => strategy.check(),
    // A finished download is where the opt-in auto-restart hooks in: with the flag on, "ready" is
    // only a momentary broadcast before apply() takes over and the app restarts to install.
    download: () => strategy.download().then(applyIfAutoRequested),
    cancel: () => strategy.cancel(),
    apply: () => strategy.apply()
  }
}

// Registers the renderer-callable update commands. Returns the strategy so the scheduler can drive it.
export const registerUpdateIpcHandlers = (
  strategy: UpdateStrategy = createUpdateStrategy(),
  owner: UpdateCommandOwner = createUpdateCommandOwner(strategy)
): UpdateStrategy => {
  ipcMainHandle('update:get-app-info', () => owner.getAppInfo())
  ipcMainHandle('update:get-status', () => owner.getStatus())
  ipcMainHandle('update:check', () => owner.check())
  ipcMainHandle('update:download', () => owner.download())
  ipcMainHandle('update:cancel', () => owner.cancel())
  ipcMainHandle('update:apply', () => owner.apply())
  return strategy
}

export { createUpdateCommandOwner }
export type { UpdateCommandOwner }
