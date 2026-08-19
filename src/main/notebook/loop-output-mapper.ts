import type { NotebookOutput } from '../../shared/notebook'

// One rendered figure produced during a cell execution; already base64-encoded by the driver.
export type MappedFigure = { mime: string; base64: string }

// The mapped result: structured outputs plus the flattened text streams the driver persists.
export type MappedLoopOutputs = {
  outputs: NotebookOutput[]
  stdout: string
  stderr: string
  traceback: string
}

// 输出预算: 单次运行的文本输出上限 (对齐上游 v0.15.1 的共享 2 MiB 文本预算), 防止长会话/
// 大输出会话的内存与 IPC 尖峰; 超出部分截断并追加标记。
export const NOTEBOOK_RUN_OUTPUT_TEXT_BUDGET = 2 * 1024 * 1024

const truncateText = (text: string, budget: number): string =>
  text.length > budget ? `${text.slice(0, budget)}\n…[output truncated]` : text

// Pure mapping from one exec-loop response to NotebookOutput[] plus flattened text streams.
// Order: stream(stdout), stream(stderr), figures (array order), result display, error.
export function mapLoopOutputs(input: {
  stdout: string
  stderr: string
  error: string | null
  errorLine?: number | null
  result: string | null
  figures: MappedFigure[]
}): MappedLoopOutputs {
  const { stdout: rawStdout, stderr: rawStderr, error, errorLine, result: rawResult, figures } = input
  const stdout = truncateText(rawStdout, NOTEBOOK_RUN_OUTPUT_TEXT_BUDGET)
  const stderr = truncateText(rawStderr, NOTEBOOK_RUN_OUTPUT_TEXT_BUDGET)
  const result = truncateText(rawResult ?? '', NOTEBOOK_RUN_OUTPUT_TEXT_BUDGET)
  const outputs: NotebookOutput[] = []

  if (stdout) outputs.push({ type: 'stream', name: 'stdout', text: stdout })
  if (stderr) outputs.push({ type: 'stream', name: 'stderr', text: stderr })

  for (const figure of figures) {
    outputs.push({ type: 'display', data: { [figure.mime]: figure.base64 } })
  }

  if (result) outputs.push({ type: 'display', data: { 'text/plain': result } })

  let traceback = ''
  if (error) {
    const errorOutput: NotebookOutput = {
      type: 'error',
      message: error.split('\n')[0],
      traceback: error
    }
    if (typeof errorLine === 'number') errorOutput.line = errorLine
    outputs.push(errorOutput)
    traceback = error
  }

  return { outputs, stdout, stderr, traceback }
}
