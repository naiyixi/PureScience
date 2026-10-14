import type { PluginFetchOutcome, PluginSourcePreview } from '../../shared/plugin-source'
import { pluginSourceEntryUrls } from '../../shared/plugin-source'

import { deployPlugin, type PluginDeployResult } from './plugin-deploy'
import type { PluginSourceCandidateStore } from './plugin-source-candidate'
import { decidePluginOperation, type PluginOperationDecision } from './plugin-run-policy'
import { runPluginOnce, type PluginRunResult } from './plugin-run'

// E3-2: the two operations, composed. Each one is: take the token the window was given, ask the gate, then
// do exactly what the gate allowed — and nothing if the token is not ours, is expired, or the gate refuses.
//
// The order matters and is the point: the gate runs BEFORE any file is written or any process is started, so
// a refusal leaves the filesystem and the process table exactly as they were.

export type PluginOperationOutcome =
  | {
      state: 'deployed'
      decision: PluginOperationDecision
      deployment: Extract<PluginDeployResult, { state: 'deployed' }>
    }
  | {
      state: 'ran'
      decision: PluginOperationDecision
      run: Extract<PluginRunResult, { state: 'ran' }>
    }
  | {
      state: 'refused'
      reason:
        | 'unknown-token'
        | 'token-expired'
        | 'not-previewed'
        | 'confirmation-missing'
        | 'protection-unavailable'
        | 'unprotected-execution-denied'
        | 'approval-required'
        | 'declaration-refused'
        | 'entry-missing'
        | 'entry-unsafe-destination'
        | 'already-deployed'
        | 'deploy-failed'
        | 'runtime-unsupported'
      detail: string
    }

const takeCandidate = (
  store: PluginSourceCandidateStore,
  token: string,
  ownerId: string | number | undefined
):
  | { ok: true; preview: Extract<PluginSourcePreview, { state: 'available' }> }
  | { ok: false; outcome: PluginOperationOutcome } => {
  const taken = store.take(token, ownerId)
  if (taken.state !== 'ok') {
    return {
      ok: false,
      outcome: {
        state: 'refused',
        reason: taken.reason,
        detail: 'No usable preview for this token.'
      }
    }
  }
  const preview = taken.record.preview
  if (preview.state !== 'available') {
    return {
      ok: false,
      outcome: {
        state: 'refused',
        reason: 'not-previewed',
        detail: 'This token names a preview that could not be read; there is nothing to deploy.'
      }
    }
  }
  return { ok: true, preview }
}

export const deployCandidate = async (input: {
  store: PluginSourceCandidateStore
  token: string
  ownerId: string | number | undefined
  pluginsRoot: string
  confirmed: boolean
  protection: Parameters<typeof decidePluginOperation>[0]['protection']
  policy: Parameters<typeof decidePluginOperation>[0]['policy']
  fetchBytes: (url: string) => Promise<PluginFetchOutcome>
}): Promise<PluginOperationOutcome> => {
  const candidate = takeCandidate(input.store, input.token, input.ownerId)
  if (!candidate.ok) return candidate.outcome

  const decision = decidePluginOperation({
    operation: 'deploy',
    confirmed: input.confirmed,
    protection: input.protection,
    policy: input.policy
  })
  if (decision.state === 'refused') {
    return { state: 'refused', reason: decision.reason, detail: decision.detail }
  }

  const ref = candidate.preview.source
  const deployment = await deployPlugin({
    manifest: candidate.preview.manifest,
    pluginsRoot: input.pluginsRoot,
    // The entries are read from the source that was previewed, at the ref it recorded: a deployment that
    // fetched from "wherever main is now" would not be a deployment of what was checked.
    readEntry: async (entry) => {
      const urls = pluginSourceEntryUrls({ owner: ref.owner, repo: ref.repo, ref: ref.ref }, entry)
      for (const url of urls) {
        const outcome = await input.fetchBytes(url)
        if (outcome.ok) return outcome.bytes
      }
      return null
    }
  })

  if (deployment.state !== 'deployed') {
    return { state: 'refused', reason: deployment.reason, detail: deployment.detail }
  }
  return { state: 'deployed', decision, deployment }
}

export const runCandidateOnce = async (input: {
  store: PluginSourceCandidateStore
  token: string
  ownerId: string | number | undefined
  pluginsRoot: string
  confirmed: boolean
  protection: Parameters<typeof decidePluginOperation>[0]['protection']
  policy: Parameters<typeof decidePluginOperation>[0]['policy']
  timeoutMs?: number
  spawnImpl?: Parameters<typeof runPluginOnce>[0]['spawnImpl']
}): Promise<PluginOperationOutcome> => {
  const candidate = takeCandidate(input.store, input.token, input.ownerId)
  if (!candidate.ok) return candidate.outcome

  // The gate first: nothing is started until it allows the run.
  const decision = decidePluginOperation({
    operation: 'run-once',
    confirmed: input.confirmed,
    protection: input.protection,
    policy: input.policy
  })
  if (decision.state === 'refused') {
    return { state: 'refused', reason: decision.reason, detail: decision.detail }
  }

  const manifest = candidate.preview.manifest
  const first = manifest.tools[0]
  const run = await runPluginOnce({
    directory: `${input.pluginsRoot}/${manifest.id}`,
    entry: first.entry,
    runtimeKind: manifest.runtime.kind,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.spawnImpl === undefined ? {} : { spawnImpl: input.spawnImpl })
  })

  if (run.state === 'refused') {
    return { state: 'refused', reason: run.reason, detail: run.detail }
  }
  return { state: 'ran', decision, run }
}
