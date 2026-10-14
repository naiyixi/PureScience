import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'

import { checkPluginDeclaration, type PluginManifest } from '../../shared/plugin-source'

// The record filename is owned by the catalogue (the module that reads it back and must recognise it before
// removing anything), so the writer and the reader cannot drift apart.
import { DEPLOYED_RECORD_FILENAME } from './plugin-catalog'

// E3-2, first piece: DEPLOY — and only deploy. Nothing here spawns anything; running the plugin is a separate
// step behind the execution-protection policy, because deploying files and running third-party code are not
// the same risk (the second one is the one worth gating).
//
// The shape is borrowed from SpecialistPackageTransaction on purpose (staging directory, then one atomic
// rename, with a rollback that leaves nothing behind), but the class is not reused: that one is bound to
// Specialists and their skills, and a plugin deployment has a manifest instead.

/**
 * Is `candidate` inside `root`?
 *
 * Compared on POSIX-normalized paths on purpose. `node:path` uses `\` on Windows, so the obvious
 * `candidate.startsWith(root + '/')` guard silently matches NOTHING there and refuses every legitimate
 * entry — a defect that passes every test on a POSIX machine and fails the whole suite on Windows.
 * Normalizing both sides (and comparing the relative path) makes the answer the same on both.
 */
export const isInsideDirectory = (root: string, candidate: string): boolean => {
  const toPosix = (value: string): string => value.replace(/\\/g, '/')
  const relative = posix.relative(toPosix(root), toPosix(candidate))
  return relative !== '' && !relative.startsWith('..') && !posix.isAbsolute(relative)
}

export type PluginDeployResult =
  | {
      state: 'deployed'
      pluginId: string
      directory: string
      /** sha256 of each declared entry, taken from the bytes that were written. */
      entries: Array<{ entry: string; bytes: number; sha256: string }>
    }
  | {
      state: 'refused'
      reason:
        | 'declaration-refused'
        | 'entry-missing'
        | 'entry-unsafe-destination'
        | 'already-deployed'
        | 'deploy-failed'
      detail: string
    }

export type PluginFileSource = (path: string) => Promise<Uint8Array | null>

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Deploys the files a manifest declares, atomically.
 *
 * The caller supplies the bytes (a read of the repository at the recorded ref); this module never fetches,
 * so what gets written is exactly what was checked. Whatever happens, the end state is either the whole
 * plugin or nothing: a plugin directory is only created by a rename after every entry was read and hashed.
 */
export const deployPlugin = async (input: {
  manifest: PluginManifest
  /** Root under which plugins live (the app's own data root). */
  pluginsRoot: string
  /** Reads one declared entry from the source that was previewed. */
  readEntry: PluginFileSource
}): Promise<PluginDeployResult> => {
  const declaration = checkPluginDeclaration(input.manifest)
  if (declaration.state !== 'ok') {
    return { state: 'refused', reason: 'declaration-refused', detail: declaration.detail }
  }

  const pluginId = input.manifest.id
  const finalDirectory = join(input.pluginsRoot, pluginId)
  const stagingDirectory = join(
    input.pluginsRoot,
    `.staging-${pluginId}-${sha256(new TextEncoder().encode(pluginId)).slice(0, 8)}`
  )

  // An existing directory is never silently replaced: overwriting a deployed plugin is a decision, and this
  // step does not make it on the user's behalf.
  const existing = await readdir(input.pluginsRoot).catch(() => [] as string[])
  if (existing.includes(pluginId)) {
    return {
      state: 'refused',
      reason: 'already-deployed',
      detail: `${pluginId} is already deployed at ${finalDirectory}; remove it first.`
    }
  }

  await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(stagingDirectory, { recursive: true })

  const entries: Array<{ entry: string; bytes: number; sha256: string }> = []
  try {
    for (const tool of input.manifest.tools) {
      // The destination is re-checked here even though the declaration already passed: this is the step that
      // writes, so the check that guards writing belongs here too.
      const destination = join(stagingDirectory, tool.entry)
      if (!isInsideDirectory(stagingDirectory, destination)) {
        // Nothing may be left behind on any refusal path, including the ones that return early: the staging
        // directory is this call's own work, so this call cleans it.
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
        return {
          state: 'refused',
          reason: 'entry-unsafe-destination',
          detail: `tools.${tool.name}.entry would be written outside the plugin directory: ${tool.entry}`
        }
      }
      const bytes = await input.readEntry(tool.entry)
      if (bytes === null) {
        // The red line's own case: a deployment that could not be completed leaves no trace — not the
        // plugin directory, and not the staging directory it was building.
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
        return {
          state: 'refused',
          reason: 'entry-missing',
          detail: `The declaration names ${tool.entry}, and the source does not have it.`
        }
      }
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes)
      entries.push({ entry: tool.entry, bytes: bytes.byteLength, sha256: sha256(bytes) })
    }

    // One rename: before it, nothing is visible; after it, everything is.
    await rename(stagingDirectory, finalDirectory)
    await writeFile(
      join(finalDirectory, DEPLOYED_RECORD_FILENAME),
      JSON.stringify({ pluginId, deployedAt: new Date().toISOString(), entries }, null, 2),
      'utf8'
    )
    return { state: 'deployed', pluginId, directory: finalDirectory, entries }
  } catch (cause) {
    // Roll back what this call created, and name the failure rather than leaving a half-deployed plugin.
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
    await rm(finalDirectory, { recursive: true, force: true }).catch(() => undefined)
    return {
      state: 'refused',
      reason: 'deploy-failed',
      detail: cause instanceof Error ? cause.message : String(cause)
    }
  }
}

/** Reads the deployed record back, so a caller can check what the directory actually holds. */
export const readDeployedPlugin = async (
  pluginsRoot: string,
  pluginId: string
): Promise<{ entries: Array<{ entry: string; bytes: number; sha256: string }> } | null> => {
  try {
    const raw = await readFile(join(pluginsRoot, pluginId, DEPLOYED_RECORD_FILENAME), 'utf8')
    const parsed = JSON.parse(raw) as {
      entries?: Array<{ entry: string; bytes: number; sha256: string }>
    }
    return { entries: parsed.entries ?? [] }
  } catch {
    return null
  }
}
