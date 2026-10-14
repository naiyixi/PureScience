import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  PLUGIN_ID_PATTERN,
  type DeployedPluginEntry,
  type DeployedPluginView,
  type PluginCatalogRemovalView
} from '../../shared/plugin-source'
import { dirSize } from '../storage/usage'

// The read side of the plugin deployer (E3-2, v2.3.0's own "not done" list).
//
// Deployment wrote the plugin and a record of what it wrote, and then nothing in the app could show it or
// remove it: deploying the same id again was refused with "remove it first", and there was no surface that
// could remove it. That is a half feature — the files are real and the reader cannot manage them.
//
// Two properties this module keeps, both borrowed from the notebook session-data cleanup because the shape
// of the problem is the same (a recursive delete of the user's own data):
//
//   * a row reports what the app ITSELF recorded (per-entry bytes and sha256 from `deployed.json`) plus the
//     directory's measured size, so a reader can recompute the row instead of trusting it;
//   * removal refuses anything the app cannot show it deployed. A directory with no readable record is
//     refused BY NAME rather than deleted: "remove this plugin" is not "delete this directory".
//
// Nothing here fetches, and nothing here runs a plugin.

/** The record `deployPlugin` writes into the plugin directory. One name, used by writer and reader alike. */
export const DEPLOYED_RECORD_FILENAME = 'deployed.json'

type CatalogLogger = {
  info: (message: string, metadata: Record<string, unknown>) => void
}

export type PluginCatalogOptions = {
  /** The app's own plugins directory (the same value the deploy path was given). */
  pluginsRoot: string
  log?: CatalogLogger
}

const isEntry = (value: unknown): value is DeployedPluginEntry => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.entry === 'string' &&
    candidate.entry !== '' &&
    typeof candidate.bytes === 'number' &&
    Number.isFinite(candidate.bytes) &&
    typeof candidate.sha256 === 'string' &&
    candidate.sha256 !== ''
  )
}

type RecordRead =
  | { state: 'ok'; deployedAt?: string; entries: DeployedPluginEntry[] }
  | { state: 'missing' }
  | { state: 'unreadable'; detail: string }

/**
 * Reads one deployment record, keeping "there is no record" apart from "there is one and it cannot be read".
 * The two are the same empty answer to a careless caller, and only the first one means "this app did not
 * deploy here".
 */
const readRecord = async (directory: string): Promise<RecordRead> => {
  const recordPath = join(directory, DEPLOYED_RECORD_FILENAME)
  let raw: string
  try {
    raw = await readFile(recordPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return {
      state: 'unreadable',
      detail: `${DEPLOYED_RECORD_FILENAME} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      state: 'unreadable',
      detail: `${DEPLOYED_RECORD_FILENAME} is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { state: 'unreadable', detail: `${DEPLOYED_RECORD_FILENAME} is not an object.` }
  }
  const record = parsed as { deployedAt?: unknown; entries?: unknown }
  if (!Array.isArray(record.entries) || !record.entries.every(isEntry)) {
    return {
      state: 'unreadable',
      detail: `${DEPLOYED_RECORD_FILENAME} does not list entries (the record was written by a newer or a different build).`
    }
  }

  return {
    state: 'ok',
    // Absent stays absent: a record without the field reports no time rather than a made-up one.
    ...(typeof record.deployedAt === 'string' ? { deployedAt: record.deployedAt } : {}),
    entries: record.entries
  }
}

/** Measured, never inferred: the directory's real size at the moment of this reading. */
const measure = async (directory: string): Promise<number> =>
  dirSize(directory, new Set()).catch(() => 0)

/**
 * One plugin directory, as a row. Every directory under the plugins root gets one — a directory with no
 * record is reported as such rather than skipped, because "this app did not deploy this" is exactly the
 * fact a reader needs before the removal refuses it.
 */
export const readDeployedPlugin = async (
  options: PluginCatalogOptions,
  pluginId: string
): Promise<DeployedPluginView> => {
  const directory = join(options.pluginsRoot, pluginId)
  const onDiskBytes = await measure(directory)
  const record = await readRecord(directory)

  if (record.state === 'missing') {
    return { state: 'record-missing', pluginId, directory, onDiskBytes }
  }
  if (record.state === 'unreadable') {
    return { state: 'record-unreadable', pluginId, directory, detail: record.detail }
  }
  return {
    state: 'deployed',
    pluginId,
    directory,
    ...(record.deployedAt === undefined ? {} : { deployedAt: record.deployedAt }),
    entries: record.entries,
    onDiskBytes
  }
}

/**
 * Every directory in the plugins root, in a stable order.
 *
 * Dot-prefixed directories are skipped on purpose: the deploy path builds its staging directory as
 * `.staging-<id>-<hash>` inside this same root, and a listing that showed that scratch as a plugin would
 * report work in progress as a result. Everything else is listed, including directories this app did not
 * deploy — as `record-missing` / `record-unreadable` rows.
 */
export const listDeployedPlugins = async (
  options: PluginCatalogOptions
): Promise<DeployedPluginView[]> => {
  const dirents = await readdir(options.pluginsRoot, { withFileTypes: true }).catch(() => [])
  const rows: DeployedPluginView[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    rows.push(await readDeployedPlugin(options, dirent.name))
  }
  return rows.sort((left, right) => left.pluginId.localeCompare(right.pluginId))
}

/**
 * Removes one deployed plugin and reports the bytes it actually freed.
 *
 * The order is the safety property: the id is checked before it is ever joined to a path, the record is
 * read before anything is deleted, and the size is measured before the removal — so the number that comes
 * back is a reading rather than a claim. A refusal frees nothing and says so with `freedBytes: 0`.
 */
export const removeDeployedPlugin = async (
  options: PluginCatalogOptions,
  request: { pluginId: string; confirmed: boolean }
): Promise<PluginCatalogRemovalView> => {
  const { pluginId } = request

  // The id is a single path segment by contract; anything else never reaches a path join. This is the
  // reason the manifest pattern is exported from the shared module rather than repeated here.
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    options.log?.info('deployed plugin removal refused', { reason: 'unsafe-plugin-id', pluginId })
    return {
      state: 'refused',
      reason: 'unsafe-plugin-id',
      detail: `"${pluginId}" is not a plugin id, so it is not a directory name this feature will delete.`,
      freedBytes: 0
    }
  }

  // Removing third-party code from disk is a decision, and this step does not make it on the reader's
  // behalf: the window sends this flag only after the confirmation it showed was checked.
  if (!request.confirmed) {
    options.log?.info('deployed plugin removal refused', {
      reason: 'confirmation-missing',
      pluginId
    })
    return {
      state: 'refused',
      reason: 'confirmation-missing',
      detail: `${pluginId} was not removed: the confirmation that names what is deleted was not given.`,
      freedBytes: 0
    }
  }

  const directory = join(options.pluginsRoot, pluginId)

  let directoryEntry: Awaited<ReturnType<typeof stat>>
  try {
    directoryEntry = await stat(directory)
  } catch {
    options.log?.info('deployed plugin removal absent', { pluginId })
    return { state: 'absent', pluginId }
  }
  if (!directoryEntry.isDirectory()) {
    options.log?.info('deployed plugin removal refused', {
      reason: 'not-a-deployed-plugin',
      pluginId
    })
    return {
      state: 'refused',
      reason: 'not-a-deployed-plugin',
      detail: `${directory} is not a directory, so there is no deployed plugin to remove.`,
      freedBytes: 0
    }
  }

  const record = await readRecord(directory)
  if (record.state !== 'ok') {
    // Fail closed: only a record this app can read proves the directory is a plugin it deployed. A
    // missing or unreadable record is named, and the directory is left exactly as it is.
    options.log?.info('deployed plugin removal refused', {
      reason: 'not-a-deployed-plugin',
      pluginId
    })
    return {
      state: 'refused',
      reason: 'not-a-deployed-plugin',
      detail:
        record.state === 'missing'
          ? `${directory} has no ${DEPLOYED_RECORD_FILENAME}; this feature removes only plugins it deployed.`
          : `${directory} was left alone: ${record.detail}`,
      freedBytes: 0
    }
  }

  const freedBytes = await measure(directory)
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    options.log?.info('deployed plugin removal failed', {
      pluginId,
      reason: error instanceof Error ? error.message : String(error)
    })
    return {
      state: 'refused',
      reason: 'removal-failed',
      detail: error instanceof Error ? error.message : String(error),
      freedBytes: 0
    }
  }

  options.log?.info('deployed plugin removed', { pluginId, freedBytes })
  return { state: 'removed', pluginId, freedBytes }
}
