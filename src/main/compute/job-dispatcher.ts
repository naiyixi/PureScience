import { createHash } from 'node:crypto'

import type { ComputeJob, ExternalComputeEndpoint } from '../../shared/compute'
import { isExternalComputeProviderId } from '../../shared/compute'
import { runModalJob, runNimJob } from './external-runner'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import type { SshRunner } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'
import type { ScpRunner } from './scp-runner'
import { SystemScpRunner, runScpUpload } from './scp-runner'
import { shellSingleQuote } from './scp-runner'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'

// Maximum number of bytes for the per-job dispatch SSH command (enough for base64 of large scripts).
const DISPATCH_MAX_OUTPUT_BYTES = 4 * 1024

// Timeout for the dispatch SSH connection (mkdir + write files + launch). Generous to accommodate
// slow cluster file systems; the job itself runs detached so the connection can close after.
const DISPATCH_TIMEOUT_MS = 120_000

// Remote handle stored in the DB once the job is launched.
export type RemoteHandle = {
  pid: number
  exit_code_path: string
  stdout_path: string
  stderr_path: string
  workdir: string
}

// Builds the launcher.sh script content for a given job.
// Uses timeout(1) with SIGTERM then SIGKILL after 30s grace. The login shell loads profile
// configuration, then attempts to source a readable .bashrc (non-interactive bash does not do so
// itself). A missing .bashrc is a no-op; a source failure returns through the normal exit-code
// lifecycle. A .bashrc may deliberately return early for non-interactive shells. exec then replaces
// the initialized shell with the user workload shell.
// exit_code is written via a tmp→rename atomic pattern so the poller never reads a partial value.
export const buildLauncherScript = (timeoutSeconds: number): string => {
  return (
    '#!/usr/bin/env bash\n' +
    `timeout -s TERM -k 30s ${timeoutSeconds} bash -l -c 'if [ -r ~/.bashrc ]; then . ~/.bashrc || exit $?; fi; exec bash command.sh' > stdout 2> stderr\n` +
    'echo $? > exit_code.tmp && mv exit_code.tmp exit_code\n'
  )
}

// Encodes a string to base64 for safe transfer via a single SSH command (avoids heredoc/quoting).
export const toBase64 = (content: string): string => Buffer.from(content).toString('base64')

// Computes the SHA-256 hash of a command string for auditing and deduplication.
export const hashCommand = (command: string): string =>
  createHash('sha256').update(command).digest('hex')

// Calculates the remote workdir path from the scratch root and job id.
// This is called both at submit time (to return immediately) and by the dispatcher.
export const computeRemoteWorkdir = (scratchRoot: string | undefined, jobId: string): string => {
  const root = scratchRoot?.trim() || '~'
  return `${root}/.purescience/jobs/${jobId}`
}

// Quotes a remote path for safe interpolation into a remote shell command, while still allowing a
// leading `~` to be expanded to $HOME by the shell. A tilde inside double/single quotes is NOT
// expanded by bash, so the `~/` prefix is left unquoted and only the remainder is single-quoted
// (single quotes also neutralise $, backticks, spaces, etc. for injection safety). Paths without a
// leading tilde are single-quoted wholesale.
export const quoteRemotePath = (path: string): string => {
  const singleQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
  if (path === '~') return '~'
  if (path.startsWith('~/')) return `~/${singleQuote(path.slice(2))}`
  return singleQuote(path)
}

// One entry in the stored input manifest. Created by ComputeService (validation/resolution)
// and consumed by the dispatcher (staging).
export type StagedInputEntry =
  | { kind: 'upload'; localPath: string; dstFilename: string; label: string }
  | { kind: 'symlink'; remotePath: string; dstFilename: string; label: string }

// Performs the remote staging for all entries: scp upload for 'upload' entries,
// remote ln -s for 'symlink' entries. All-or-nothing: throws on first failure.
// Called inside dispatchJob after the SSH target is resolved.
export const stageInputs = async (
  entries: StagedInputEntry[],
  workdir: string,
  runner: SshRunner,
  target: import('./ssh-runner').ResolvedSshTarget,
  scpRunner: ScpRunner
): Promise<void> => {
  for (const entry of entries) {
    if (entry.kind === 'upload') {
      const remoteDest = `${workdir}/${entry.dstFilename}`
      await runScpUpload(scpRunner, target, entry.localPath, remoteDest)
    } else {
      // Remote symlink: ln -s /abs/path workdir/dst_filename
      const quoted = shellSingleQuote(entry.remotePath)
      const destQ = quoteRemotePath(`${workdir}/${entry.dstFilename}`)
      const lnCmd = `ln -s ${quoted} ${destQ}`
      const result = await runner.run(target, lnCmd, {
        timeoutMs: 30_000,
        loginShell: false,
        maxOutputBytes: 4 * 1024
      })
      if (result.exitCode !== 0) {
        throw new Error(
          `ln -s failed for ${entry.label}: ${result.stderr.trim() || `exit ${result.exitCode ?? 'null'}`}`
        )
      }
    }
  }
}

// Dependency interface for the dispatcher. Tests inject a fake SshRunner.
export type DispatcherDeps = {
  runner: SshRunner
  scpRunner?: ScpRunner
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  // Optional broadcast hook for Phase 3d renderer IPC; no-op when omitted (Phase 3a).
  onJobUpdated?: (job: ComputeJob) => void
  // Tracks this dispatch as in-flight so the poller won't mistake a job that is still staging
  // inputs for a restart-orphaned one. Defaults to the process-wide shared tracker.
  dispatchTracker?: DispatchTracker
  // External compute endpoints (modal / nvidia_nim), resolved lazily from settings. Absent ⇒
  // external provider ids fail dispatch with a clear error (unconfigured environment).
  externalEndpoints?: () => Promise<ExternalComputeEndpoint[]>
  // Resolves the plaintext secret for a Credentials-panel credential id. Absent ⇒ external
  // dispatch cannot authenticate.
  resolveCredentialSecret?: (credentialId: string) => Promise<string | undefined>
}

// Dispatches one job to its remote host asynchronously (not awaited by submit_job RPC).
// Transitions: submitted → running (success) or error (any failure).
export async function dispatchJob(jobId: string, deps: DispatcherDeps): Promise<void> {
  const tracker = deps.dispatchTracker ?? sharedDispatchTracker
  // Mark in-flight synchronously (before the first await) so the poller can never observe this job
  // as untracked while its dispatch is genuinely running. Cleared in the finally below.
  tracker.begin(jobId)
  try {
    await dispatchJobInner(jobId, deps)
  } finally {
    tracker.end(jobId)
  }
}

// Dispatches a job to an external compute target (Modal serverless GPU or NVIDIA NIM inference).
// The endpoint config and its credential secret come from the injected providers; without them the
// job fails with a clear dispatch error.
async function dispatchExternalJob(job: ComputeJob, deps: DispatcherDeps): Promise<void> {
  const { jobRepository, onJobUpdated } = deps

  const fail = async (
    stderrTail: string,
    errorCode: 'dispatch_failed' | 'host_unreachable' = 'dispatch_failed'
  ): Promise<void> => {
    const updated = await jobRepository.update(job.job_id, {
      status: 'error',
      errorCode,
      stderrTail,
      finishedAt: new Date()
    })
    onJobUpdated?.(updated)
  }

  if (!deps.externalEndpoints || !deps.resolveCredentialSecret) {
    await fail('External compute dispatch is not configured in this environment.')
    return
  }

  const endpoints = await deps.externalEndpoints()
  const endpoint = endpoints.find((candidate) => candidate.providerId === job.provider_id)
  if (!endpoint) {
    await fail(
      `No external compute endpoint configured for ${job.provider_id}.`,
      'host_unreachable'
    )
    return
  }

  const secret = await deps.resolveCredentialSecret(endpoint.credentialId)
  if (!secret) {
    await fail(
      `Credential ${endpoint.credentialId} has no secret — configure it in Settings → Credentials.`
    )
    return
  }

  let outcome
  if (endpoint.kind === 'modal') {
    // Modal: expose the credential as the standard Modal token env vars; the CLI authenticates
    // from them. `modal run` executes the job command in a GPU container.
    outcome = await runModalJob(endpoint, job.command, {
      MODAL_TOKEN_ID: secret,
      MODAL_TOKEN_SECRET: secret
    })
  } else {
    outcome = await runNimJob(endpoint, job.command, secret)
  }

  const updated = await jobRepository.update(job.job_id, {
    status: outcome.exitCode === 0 ? 'success' : 'failed',
    exitCode: outcome.exitCode,
    stdoutTail: outcome.stdout.slice(-64_000),
    stderrTail: outcome.stderr.slice(-64_000),
    finishedAt: new Date()
  })
  onJobUpdated?.(updated)
}

async function dispatchJobInner(jobId: string, deps: DispatcherDeps): Promise<void> {
  const { runner, hostRepository, jobRepository, onJobUpdated } = deps
  const scpRunner = deps.scpRunner ?? new SystemScpRunner()

  const job = await jobRepository.get(jobId)
  if (!job) return // already gone (unlikely but guard anyway)

  // External compute targets (modal / nvidia_nim) are dispatched by kind instead of SSH.
  if (isExternalComputeProviderId(job.provider_id)) {
    await dispatchExternalJob(job, deps)
    return
  }

  const host = await hostRepository.get(job.provider_id)
  if (!host) {
    const updated = await jobRepository.update(jobId, {
      status: 'error',
      errorCode: 'dispatch_failed',
      finishedAt: new Date()
    })
    onJobUpdated?.(updated)
    return
  }

  // Resolve SSH target (runs ssh -G). Failure = host_unreachable.
  let target
  try {
    target = await resolveSshTarget(host.sshAlias, host.sshOverrides)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const updated = await jobRepository.update(jobId, {
      status: 'error',
      errorCode: 'host_unreachable',
      stderrTail: msg,
      finishedAt: new Date()
    })
    onJobUpdated?.(updated)
    return
  }

  const workdir = job.remote_workdir ?? computeRemoteWorkdir(host.scratchRoot, jobId)
  const timeoutSecs = job.timeout_seconds ?? 86400 // default 24h

  // Stage inputs declared in the manifest (all-or-nothing: failure → dispatch_failed).
  if (job.input_manifest) {
    let entries: StagedInputEntry[]
    try {
      entries = JSON.parse(job.input_manifest) as StagedInputEntry[]
    } catch {
      const updated = await jobRepository.update(jobId, {
        status: 'error',
        errorCode: 'dispatch_failed',
        stderrTail: 'Failed to parse inputManifest JSON',
        finishedAt: new Date()
      })
      onJobUpdated?.(updated)
      return
    }

    // Mkdir workdir first so symlinks and uploads have a destination.
    const mkdirResult = await runner.run(target, `mkdir -p ${quoteRemotePath(workdir)}`, {
      timeoutMs: 30_000,
      loginShell: false,
      maxOutputBytes: 4 * 1024
    })
    if (mkdirResult.exitCode !== 0) {
      const tail = mkdirResult.stderr || `mkdir exit ${mkdirResult.exitCode ?? 'null'}`
      const updated = await jobRepository.update(jobId, {
        status: 'error',
        errorCode: 'dispatch_failed',
        stderrTail: tail,
        finishedAt: new Date()
      })
      onJobUpdated?.(updated)
      return
    }

    try {
      await stageInputs(entries, workdir, runner, target, scpRunner)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const updated = await jobRepository.update(jobId, {
        status: 'error',
        errorCode: 'dispatch_failed',
        stderrTail: `Input staging failed: ${msg}`,
        finishedAt: new Date()
      })
      onJobUpdated?.(updated)
      return
    }
  }

  // Build scripts.
  const commandScript = job.command // raw command content written to command.sh
  const launcherScript = buildLauncherScript(timeoutSecs)

  // Encode to base64 to avoid all shell quoting/injection issues.
  const commandB64 = toBase64(commandScript)
  const launcherB64 = toBase64(launcherScript)

  // One SSH command: mkdir workdir, write scripts via base64 pipes, launch detached, echo pid.
  // Stdout = the pid (we echo it last).
  const quotedWorkdir = quoteRemotePath(workdir)
  const dispatchCmd = [
    `mkdir -p ${quotedWorkdir}`,
    `cd ${quotedWorkdir}`,
    // Write command.sh and launcher.sh via base64 to avoid heredoc/quoting issues.
    `printf '%s' ${JSON.stringify(commandB64)} | base64 -d > command.sh`,
    `printf '%s' ${JSON.stringify(launcherB64)} | base64 -d > launcher.sh`,
    `chmod +x command.sh launcher.sh`,
    // Detached launch: nohup + setsid so the process survives SSH disconnect.
    `nohup setsid bash launcher.sh >/dev/null 2>&1 &`,
    // Write pid to file AND echo it so we can read it back in this round-trip.
    `LAUNCHED_PID=$!`,
    `echo $LAUNCHED_PID > job.pid`,
    `echo $LAUNCHED_PID`
  ].join('\n')

  const runResult = await runner.run(target, dispatchCmd, {
    timeoutMs: DISPATCH_TIMEOUT_MS,
    loginShell: false,
    maxOutputBytes: DISPATCH_MAX_OUTPUT_BYTES
  })

  // Connection-level failure.
  if (runResult.timedOut || runResult.exitCode === 255) {
    const tail = runResult.stderr || 'SSH connection failed'
    const updated = await jobRepository.update(jobId, {
      status: 'error',
      errorCode: 'host_unreachable',
      stderrTail: tail,
      finishedAt: new Date()
    })
    onJobUpdated?.(updated)
    return
  }

  // Non-connection failure (mkdir, base64, etc.)
  if (runResult.exitCode !== 0) {
    const tail = runResult.stderr || `exit code ${runResult.exitCode ?? 'null'}`
    const updated = await jobRepository.update(jobId, {
      status: 'error',
      errorCode: 'dispatch_failed',
      stderrTail: tail,
      finishedAt: new Date()
    })
    onJobUpdated?.(updated)
    return
  }

  // Parse pid from stdout (last non-empty line).
  const pid = Number.parseInt(runResult.stdout.trim().split('\n').pop() ?? '', 10)
  if (!Number.isFinite(pid) || pid <= 0) {
    const updated = await jobRepository.update(jobId, {
      status: 'error',
      errorCode: 'dispatch_failed',
      stderrTail: `Could not read pid from dispatch output: ${JSON.stringify(runResult.stdout)}`,
      finishedAt: new Date()
    })
    onJobUpdated?.(updated)
    return
  }

  // Build the remote handle JSON.
  const handle: RemoteHandle = {
    pid,
    exit_code_path: `${workdir}/exit_code`,
    stdout_path: `${workdir}/stdout`,
    stderr_path: `${workdir}/stderr`,
    workdir
  }

  const updated = await jobRepository.update(jobId, {
    status: 'running',
    remoteHandle: JSON.stringify(handle),
    startedAt: new Date()
  })
  onJobUpdated?.(updated)
}
