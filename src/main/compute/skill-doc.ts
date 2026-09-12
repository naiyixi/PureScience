import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ENGINE_CATALOG, evaluateEngineAvailability } from '../../shared/engine-catalog'
import type { ComputeHost } from '../../shared/compute'

const COMPUTE_SKILL_ID = 'remote-compute-ssh'
const COMPUTE_SKILL_DIRECTORY = `os-${COMPUTE_SKILL_ID}`
const HOST_PROJECTION_START = '<!-- purescience:compute-hosts:start -->'
const HOST_PROJECTION_END = '<!-- purescience:compute-hosts:end -->'
const READINESS_START = '<!-- purescience:compute-readiness:start -->'
const READINESS_END = '<!-- purescience:compute-readiness:end -->'

const statusLabel = (host: ComputeHost): string =>
  host.probeResult === undefined
    ? 'not yet probed'
    : host.probeResult.ok
      ? 'connected'
      : 'probe failed'

const renderHostProjection = (hosts: readonly ComputeHost[]): string =>
  hosts.length === 0
    ? '  (no hosts registered yet)'
    : hosts
        .map(
          (host) =>
            `  - ${host.displayName} (provider_id: \`${host.providerId}\`, shape: ${host.shape}, execution: ${
              host.executionMode === 'slurm' ? 'slurm (sbatch)' : 'direct-ssh'
            }, status: ${statusLabel(host)})`
        )
        .join('\n')

const projectionPattern = new RegExp(
  `${HOST_PROJECTION_START}\\n[\\s\\S]*?${HOST_PROJECTION_END}`,
  'm'
)

const withHostProjection = (document: string, projection: string): string => {
  const markedProjection = `${HOST_PROJECTION_START}\n${projection}\n${HOST_PROJECTION_END}`
  if (projectionPattern.test(document)) {
    return document.replace(projectionPattern, markedProjection)
  }

  // Migrate a pre-marker bundled copy in place. This only changes the known Registered hosts section
  // of the SSH Compute Skill; other bundled guidance stays byte-for-byte intact.
  const registeredHosts = /^(## Registered hosts\n\n)[\s\S]*?(?=^## |\s*$)/m
  if (registeredHosts.test(document)) {
    return document.replace(registeredHosts, `$1${markedProjection}\n\n`)
  }

  return document
}

const extractHostProjection = (document: string): string | undefined => {
  const match = projectionPattern.exec(document)
  if (!match) return undefined
  return match[0].slice(HOST_PROJECTION_START.length, -HOST_PROJECTION_END.length).trim()
}

const readinessPattern = new RegExp(`${READINESS_START}\\n[\\s\\S]*?${READINESS_END}`, 'm')

const withReadinessProjection = (document: string, projection: string): string => {
  const marked = `${READINESS_START}\n${projection}\n${READINESS_END}`
  if (readinessPattern.test(document)) return document.replace(readinessPattern, marked)
  return document
}

const extractReadinessProjection = (document: string): string | undefined => {
  const match = readinessPattern.exec(document)
  if (!match) return undefined
  return match[0].slice(READINESS_START.length, -READINESS_END.length).trim()
}

const acceleratorLines = (hosts: readonly ComputeHost[]): string[] => {
  const withGpus = hosts.filter((host) => (host.probeResult?.gpus?.length ?? 0) > 0)
  if (withGpus.length === 0) {
    return ['  - none of the registered hosts reported GPUs at probe time']
  }
  return withGpus.map((host) => {
    const detail = (host.probeResult?.gpus ?? [])
      .map((gpu) => `${gpu.type} ×${gpu.count}`)
      .join(', ')
    return `  - ${host.displayName}: ${detail}`
  })
}

// Engine availability projection (v1.56): the readiness ladder above tells the agent *whether* a
// host exists; this block tells it *which engines* can serve a request here, derived from the same
// catalog the UI uses. Blocked engines are listed with their reason, so "no engine" is a fact the
// agent can quote rather than a guess — and predicted engines are marked as predictions.
export const renderEngineAvailability = (hosts: readonly ComputeHost[]): string => {
  const hasComputeHost = hosts.some((host) => host.probeResult?.ok === true)
  const hostGpus = hosts.flatMap((host) => host.probeResult?.gpus ?? [])
  const context = {
    // A GPU is only claimed when a probed host actually reported one; the local machine never
    // advertises a GPU it has not proven.
    hasGpu: hostGpus.length > 0,
    allowOnDemandDownload: false,
    hasComputeHost
  }
  const lines: string[] = ['Engines available for this project (from the engine catalog):']
  for (const engine of ENGINE_CATALOG) {
    const availability = evaluateEngineAvailability(engine, context)
    const output =
      engine.outputKind === 'measured'
        ? 'measured'
        : engine.outputKind === 'lookup'
          ? 'database lookup'
          : 'PREDICTED (must be labelled, never presented as a measurement)'
    const status =
      availability.status === 'ready'
        ? 'available'
        : availability.status === 'needs-consent'
          ? `needs user consent: ${availability.reason}`
          : availability.status === 'needs-host'
            ? `needs a compute host: ${availability.reason}`
            : `unavailable: ${availability.reason}`
    lines.push(`  - ${engine.id} (${engine.label}) — ${output} — ${status}`)
  }
  lines.push(
    '',
    'Engine rules: never start a weight download or a job without the user approving it; a PREDICTED',
    'output must say so wherever it appears; if nothing above can produce the number, say "not',
    'computed: <what> — requires <engine or host>" instead of describing the number qualitatively.'
  )
  return lines.join('\n')
}

// Recommendation-only compute ladder. It tells the agent what is actually available and how to
// report honestly when nothing is — the agent never auto-submits jobs, never installs engines, and
// never substitutes a qualitative description for a requested number.
const renderComputeReadiness = (hosts: readonly ComputeHost[]): string => {
  const schedulers = hosts.filter((host) => host.executionMode === 'slurm')
  const connected = hosts.filter((host) => host.probeResult?.ok === true)
  return [
    'Accelerators reported by registered hosts:',
    ...acceleratorLines(hosts),
    '',
    'Hosts ready for jobs:',
    `  - connected: ${connected.length === 0 ? 'none' : connected.map((host) => host.displayName).join(', ')}`,
    `  - scheduler dispatch (slurm/sbatch): ${
      schedulers.length === 0 ? 'none' : schedulers.map((host) => host.displayName).join(', ')
    }`,
    '',
    'Quantitative-result ladder — follow in order, and never invent a number:',
    '  1. If a registered host above fits the job, propose it and wait for the user to approve the job (never submit silently).',
    '  2. If the question concerns a known molecule or structure, a database/connector answer (e.g. AlphaFold DB, PDB) may be used — label it a database prediction, not a computed result.',
    '  3. If no available engine can produce the requested quantity (for example ΔΔG or MD on a laptop without a GPU), state plainly "not computed: <what> — requires <engine or host>" with setup guidance.',
    '  4. Never replace a requested number with a qualitative description (an ASCII sketch, "roughly X Å away") and never fabricate a value.',
    '  5. Report provenance for every number: engine, engine version, parameters, and input identifiers.',
    '',
    renderEngineAvailability(hosts)
  ].join('\n')
}

// Applies the dynamic host data from an earlier canonical document to a freshly copied bundled one.
// Generic Skill materialization therefore refreshes shipped guidance without erasing runtime state.
const preserveComputeHostProjection = (document: string, priorDocument: string): string => {
  const hosts = extractHostProjection(priorDocument)
  const readiness = extractReadinessProjection(priorDocument)
  const withHosts = hosts === undefined ? document : withHostProjection(document, hosts)
  return readiness === undefined ? withHosts : withReadinessProjection(withHosts, readiness)
}

// Updates the application-managed canonical Skill in place. The generic materializer owns creation of
// the os- directory; a missing document means this framework has not been provisioned yet, so there
// is intentionally nothing to create or expose.
const syncComputeSkillDoc = async (
  skillsDir: string,
  hosts: readonly ComputeHost[]
): Promise<void> => {
  const directory = join(skillsDir, COMPUTE_SKILL_DIRECTORY)
  const file = join(directory, 'SKILL.md')
  let document: string
  try {
    document = await readFile(file, 'utf8')
  } catch {
    return
  }

  const updated = withReadinessProjection(
    withHostProjection(document, renderHostProjection(hosts)),
    renderComputeReadiness(hosts)
  )
  if (updated === document) return

  // Materialized Skills are normally read-only. Temporarily restore only this application-owned
  // document, then restore its prior protections once the host projection is durable.
  const [directoryMode, fileMode] = await Promise.all([
    stat(directory)
      .then((entry) => entry.mode & 0o777)
      .catch(() => undefined),
    stat(file)
      .then((entry) => entry.mode & 0o777)
      .catch(() => undefined)
  ])
  await chmod(directory, 0o755).catch(() => undefined)
  await chmod(file, 0o644).catch(() => undefined)
  try {
    await writeFile(file, updated, 'utf8')
  } finally {
    if (fileMode !== undefined) await chmod(file, fileMode).catch(() => undefined)
    if (directoryMode !== undefined) await chmod(directory, directoryMode).catch(() => undefined)
  }
}

const hasCanonicalComputeSkillDoc = async (skillsDir: string): Promise<boolean> =>
  readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    .then(() => true)
    .catch(() => false)

export {
  COMPUTE_SKILL_DIRECTORY,
  COMPUTE_SKILL_ID,
  hasCanonicalComputeSkillDoc,
  preserveComputeHostProjection,
  renderComputeReadiness,
  syncComputeSkillDoc
}
