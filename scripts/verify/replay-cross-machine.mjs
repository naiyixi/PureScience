// 4.1 的跨机重放演练：**在一台机器上封存记录，在另一台机器上重跑并判定**。
//
// 用法：
//   node --experimental-strip-types scripts/verify/replay-cross-machine.mjs record
//   node --experimental-strip-types scripts/verify/replay-cross-machine.mjs replay
//
// record 只在开发机跑一次（产物写成仓库里的 recipe），replay 在 CI 的 Linux/Windows runner 上跑。
// 两次跑的是同一段分析代码、同一份输入字节，判定用的是产品自己的 `compareReplayOutputs`
// （src/shared/replay-verification.ts）—— 不是演练脚本自己发明的比较逻辑。
//
// 判据：replay 侧必须得到 `reproduced`；同时跑一次**反向对照**（把一个输出的 digest 改掉），
// 必须得到 `differs`。两条都要成立，否则退出码非 0：只报「一致」而不证明「能分辨不一致」，
// 等于没判。
/* eslint-disable @typescript-eslint/explicit-function-return-type -- 这是 .mjs 演练脚本，
   不是产品代码：它的输入输出都是 JSON 打印与退出码，注解返回类型只会把判据藏起来。 */
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REPLAY_RECIPE_FORMAT_VERSION,
  compareReplayOutputs
} from '../../src/shared/replay-verification.ts'

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/replay-drill/', import.meta.url))
const RECIPE_PATH = fileURLToPath(
  new URL('../../docs/evidence/replay-recipes/mean-summary.json', import.meta.url)
)
const INPUT_FILES = ['analysis.py', 'measurements.csv']
const OUTPUT_FILES = ['summary.csv', 'counts.json']
/** 记录格式自己的版本，不跟应用版本走：这个 recipe 记录的是这段分析，不是某次发版。 */
const RECIPE_APP_VERSION = 'replay-drill@1'
/**
 * Windows runner 上解释器叫 `python`，POSIX 上是 `python3` —— 这不是「差不多」，是命令名真的不同，
 * 所以按平台取，并允许用环境变量覆盖（CI 里各平台各给一个值，读数是同一个 recipe）。
 */
const PYTHON = process.env.PS_DRILL_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const runPython = (cwd) =>
  new Promise((resolve) => {
    execFile(PYTHON, ['analysis.py'], { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? (error.code ?? 1) : 0, stdout, stderr })
    })
  })

const materialiseWorkspace = async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ps-replay-drill-'))
  for (const name of INPUT_FILES) {
    await copyFile(join(FIXTURE_DIR, name), join(workspace, name))
  }
  return workspace
}

const readOutputs = async (workspace) =>
  Promise.all(
    OUTPUT_FILES.map(async (name) => {
      const bytes = await readFile(join(workspace, name))
      return { path: name, sha256: sha256(bytes), sizeBytes: bytes.byteLength }
    })
  )

const record = async () => {
  const workspace = await materialiseWorkspace()
  try {
    const execution = await runPython(workspace)
    if (execution.exitCode !== 0) {
      throw new Error(`analysis failed while recording: ${execution.stderr || execution.stdout}`)
    }
    const inputs = await Promise.all(
      INPUT_FILES.map(async (name) => {
        const bytes = await readFile(join(workspace, name))
        // 输入字节随记录一起走，重放侧不需要第二份副本：记录本身足以重建输入。
        return {
          path: name,
          sha256: sha256(bytes),
          sizeBytes: bytes.byteLength,
          bytes: bytes.toString('base64')
        }
      })
    )
    const recipe = {
      formatVersion: REPLAY_RECIPE_FORMAT_VERSION,
      appVersion: RECIPE_APP_VERSION,
      origin: 'executed',
      inputs,
      outputs: await readOutputs(workspace),
      // 记下真的解释器版本，而不是「system」：重放侧的版本可能不同，而这正是要被看见的东西
      // —— 字节仍然一致时，说明结果不依赖那次环境；不一致时，这条读数就是解释的一部分。
      environmentLockRef: `python3 ${(
        await import('node:child_process')
      )
        .execSync(`${PYTHON} --version`)
        .toString()
        .trim()
        .replace(/^Python\s+/u, '')}`
    }
    await writeFile(RECIPE_PATH, `${JSON.stringify(recipe, null, 2)}\n`, 'utf8')
    return { mode: 'record', workspace, recipePath: RECIPE_PATH, outputs: recipe.outputs }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

const replay = async () => {
  const recipe = JSON.parse(await readFile(RECIPE_PATH, 'utf8'))
  if (recipe.origin !== 'executed') {
    throw new Error(`recipe origin is ${recipe.origin}; only an executed run can be re-run`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'ps-replay-drill-'))
  try {
    // 输入来自记录本身（base64 字节），不从开发机的工作副本取 —— 否则「跨机」就成了「跨目录」。
    for (const input of recipe.inputs) {
      await writeFile(join(workspace, input.path), Buffer.from(input.bytes, 'base64'))
      const landed = await readFile(join(workspace, input.path))
      if (sha256(landed) !== input.sha256) {
        throw new Error(`materialised ${input.path} does not match its recorded digest`)
      }
    }
    const execution = await runPython(workspace)
    if (execution.exitCode !== 0) {
      return {
        mode: 'replay',
        verdict: 'unverifiable',
        reason: `analysis failed on this machine: ${execution.stderr || execution.stdout}`,
        platform: `${process.platform}-${process.arch}`,
        python: (await import('node:child_process')).execSync(`${PYTHON} --version`).toString().trim()
      }
    }
    const outputs = await readOutputs(workspace)
    const report = compareReplayOutputs(
      recipe,
      { appVersion: RECIPE_APP_VERSION, outputs },
      're-run'
    )

    // 反向对照：把一个输出的 digest 改掉，判定必须变成 differs —— 证明比对不是恒真。
    const tampered = outputs.map((output, index) =>
      index === 0 ? { ...output, sha256: 'f'.repeat(64) } : output
    )
    const control = compareReplayOutputs(
      recipe,
      { appVersion: RECIPE_APP_VERSION, outputs: tampered },
      're-run'
    )

    const python = (await import('node:child_process'))
      .execSync(`${PYTHON} --version`)
      .toString()
      .trim()
    return {
      mode: 'replay',
      platform: `${process.platform}-${process.arch}`,
      python,
      verdict: report.verdict,
      files: report.files,
      reasons: report.reasons,
      negativeControl: { verdict: control.verdict, reasons: control.reasons }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

const mode = process.argv[2]
if (mode !== 'record' && mode !== 'replay') {
  console.error('usage: replay-cross-machine.mjs <record|replay>')
  process.exit(2)
}

const result = mode === 'record' ? await record() : await replay()
console.log(JSON.stringify(result, null, 2))

if (mode === 'replay') {
  const passed = result.verdict === 'reproduced' && result.negativeControl?.verdict === 'differs'
  process.exit(passed ? 0 : 1)
}
