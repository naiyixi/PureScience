import { join } from 'node:path'
import type { SaveDialogOptions, SaveDialogReturnValue, WebContents } from 'electron'

import { ipcMainHandle } from '../ipc-handler-registry'
import { createLogger, errorLogFields } from '../logger'
import { showSettingsSaveDialog } from '../settings/save-dialog'
import { SUPPORT_BUNDLE_CHANNEL, type ExportSupportBundleResult } from '../../shared/diagnostics'
import { createSupportBundle, type SupportBundleInput } from './support-bundle'

/** Everything the bundle needs that is not decided at export time (log directory, output path). */
export type SupportBundleFacts = Omit<SupportBundleInput, 'logDir' | 'outPath' | 'now'>

type SupportBundleWriteResult = Readonly<{ path: string; bytes: number; redactions: number }>

export type SupportBundleCommandOwner = Readonly<{
  exportBundle: (sender: WebContents) => Promise<ExportSupportBundleResult>
}>

export type SupportBundleCommandDeps = Readonly<{
  getLogDir: () => string
  getFacts: () => SupportBundleFacts
  /**
   * Directory the save dialog opens in. Resolved lazily and defensively: `app.getPath` throws when the
   * folder cannot be resolved — a fresh Windows profile has no Downloads folder — and an export must not
   * depend on that existing. The file name is stamped when the dialog opens, so two exports cannot collide.
   */
  getDefaultDir: () => string | undefined
  showSaveDialog?: (
    sender: WebContents,
    options: SaveDialogOptions
  ) => Promise<SaveDialogReturnValue>
  create?: (input: SupportBundleInput) => Promise<SupportBundleWriteResult>
  now?: () => Date
  log?: Readonly<{ warn: (message: string, fields?: unknown) => void }>
}>

/**
 * Directory to open the save dialog in, trying each candidate in turn: `app.getPath` throws for a folder the
 * platform cannot resolve, and a fresh Windows profile without a Downloads folder does exactly that.
 * Returns undefined when none resolves, which the caller treats as "let the platform decide".
 */
export const resolveDefaultSaveDirectory = (
  getPath: (name: 'downloads' | 'home' | 'documents' | 'userData') => string
): string | undefined => {
  for (const name of ['downloads', 'home', 'documents', 'userData'] as const) {
    try {
      const resolved = getPath(name)
      if (resolved) return resolved
    } catch {
      // Try the next candidate: the point of the chain is that one missing folder is not fatal.
    }
  }
  return undefined
}

const fileStamp = (now: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('')
}

/**
 * Assembles a support bundle on the user's machine after they pick where it goes. Nothing is transmitted:
 * the bundle is written locally, and `createSupportBundle` refuses to produce one that still contains the
 * home directory, the user name or a secret-shaped value.
 */
export const createSupportBundleCommandOwner = (
  deps: SupportBundleCommandDeps
): SupportBundleCommandOwner => {
  const showSaveDialog = deps.showSaveDialog ?? showSettingsSaveDialog
  const create = deps.create ?? createSupportBundle
  const log = deps.log ?? createLogger('diagnostics')
  const now = deps.now ?? ((): Date => new Date())

  return {
    exportBundle: async (sender: WebContents): Promise<ExportSupportBundleResult> => {
      // A throwing or empty directory must not fail the export: without a default path the dialog simply
      // opens wherever the platform prefers, which is still a working export.
      let defaultDir: string | undefined
      try {
        defaultDir = deps.getDefaultDir() || undefined
      } catch {
        defaultDir = undefined
      }
      const defaultPath = defaultDir
        ? join(defaultDir, `support-bundle-${fileStamp(now())}.tar.gz`)
        : undefined

      const selected = await showSaveDialog(sender, {
        title: 'Export support bundle',
        ...(defaultPath ? { defaultPath } : {}),
        filters: [{ name: 'Support bundle', extensions: ['gz'] }]
      })

      // Cancelling is a normal outcome, not a failure: report it as "nothing exported" with no error.
      if (selected.canceled || !selected.filePath) return { exported: false }

      try {
        const result = await create({
          ...deps.getFacts(),
          logDir: deps.getLogDir(),
          outPath: selected.filePath,
          now
        })
        return {
          exported: true,
          path: result.path,
          bytes: result.bytes,
          redactions: result.redactions
        }
      } catch (error) {
        log.warn('support bundle export failed', errorLogFields(error))
        return {
          exported: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }
}

// No default owner on purpose: the facts (versions, locale, storage location class) live in the bootstrap
// that already resolved the data root, so a fallback here would have to invent them.
export const registerSupportBundleIpcHandlers = (
  owner: SupportBundleCommandOwner
): SupportBundleCommandOwner => {
  ipcMainHandle(SUPPORT_BUNDLE_CHANNEL, (event) => owner.exportBundle(event.sender))
  return owner
}
