// External compute execution: Modal serverless GPU jobs (via the modal CLI) and NVIDIA NIM
// inference endpoints (OpenAI-compatible HTTP). These are the non-SSH branches of the compute
// dispatcher — the dispatcher routes by provider_id prefix ("modal:", "nvidia_nim:") and this
// module turns a compute job into either a `modal run` invocation or an HTTP model call.

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExternalComputeEndpoint } from '../../shared/compute'

export type ExternalJobOutcome = {
  exitCode: number | null
  stdout: string
  stderr: string
}

// Modal: writes a minimal Modal app entry that runs the job command inside a GPU container, then
// invokes `modal run`. Requires the modal CLI on PATH and the Modal token in the environment
// (injected from the Credentials panel by the caller).
export const runModalJob = async (
  _endpoint: ExternalComputeEndpoint,
  command: string,
  env: NodeJS.ProcessEnv
): Promise<ExternalJobOutcome> => {
  const dir = await mkdtemp(join(tmpdir(), 'purescience-modal-'))
  const entry = join(dir, 'entry.py')
  // A Modal app that executes the job command in a container with GPU support. The command is
  // written to a script file inside the container to avoid shell-escaping issues.
  const script = join(dir, 'job.sh')
  await writeFile(script, command, { mode: 0o755 })
  await writeFile(
    entry,
    [
      'import subprocess',
      'import modal',
      '',
      'app = modal.App("purescience-job")',
      '',
      '@app.function(gpu="T4", timeout=3600)',
      'def run_job():',
      '    return subprocess.run(["/job.sh"], capture_output=True, text=True).returncode',
      ''
    ].join('\n')
  )
  try {
    const result = await execFileAsync('modal', ['run', entry], {
      env: { ...process.env, ...env, MODAL_ENTRYPOINT: entry, JOB_SCRIPT: script }
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { exitCode: 1, stdout: '', stderr: message }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// NVIDIA NIM: sends the job command as a prompt to an OpenAI-compatible /v1/chat/completions
// endpoint and returns the model's text output. The API key comes from the Credentials panel.
export const runNimJob = async (
  endpoint: ExternalComputeEndpoint,
  command: string,
  apiKey: string
): Promise<ExternalJobOutcome> => {
  const baseUrl = (endpoint.baseUrl ?? 'http://127.0.0.1:8000/v1').replace(/\/$/, '')
  const modelName = endpoint.modelName ?? 'meta/llama-3.1-8b-instruct'
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: command }],
        max_tokens: 4096
      }),
      signal: AbortSignal.timeout(120_000)
    })
    if (!response.ok) {
      return { exitCode: 1, stdout: '', stderr: `NIM endpoint returned HTTP ${response.status}` }
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = payload.choices?.[0]?.message?.content ?? ''
    return { exitCode: 0, stdout: text, stderr: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { exitCode: 1, stdout: '', stderr: `NIM call failed: ${message}` }
  }
}

const execFileAsync = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv }
): Promise<ExternalJobOutcome> =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: options.env, timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // ENOENT (CLI not installed) or any other spawn failure: surface the message. Use ||
          // because ENOENT delivers an empty stderr string, not null.
          resolve({
            exitCode: typeof error.code === 'number' ? error.code : 1,
            stdout: String(stdout ?? ''),
            stderr: String(stderr || error.message || '')
          })
          return
        }
        resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
