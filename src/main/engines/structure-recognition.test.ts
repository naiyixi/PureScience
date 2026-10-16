import { describe, expect, it } from 'vitest'

import {
  recognizeFigureStructure,
  resolveEnginePython,
  resolveStructureRecognitionScript
} from './structure-recognition'
import type { StructureRecognitionDeps } from './structure-recognition'

// 这一套跑的是**运行器**：用注入的缝（runJson）代替真 python，这样判定、失败具名与指纹都能在
// 没有引擎的机器上钉住。真机读数另有其人（探针 + 两台真引擎）。

const rasterizeOk = {
  ok: true,
  path: '/tmp/whatever/figure.png',
  dpi: 200,
  pixels: { width: 640, height: 480 },
  pageSize: { width: 595, height: 842 }
}

const engineOk = (
  smiles: string,
  revision: string
): { ok: boolean; engine: string; revision: string; smiles: string } => ({
  ok: true,
  engine: 'x',
  revision,
  smiles
})
const canonicalOk = (
  canonical: string,
  formula = 'C2H6O'
): { ok: boolean; canonical: string; formula: string } => ({ ok: true, canonical, formula })

describe('resolveStructureRecognitionScript', () => {
  it('takes the env override, then resourcesPath, then the development tree', () => {
    const here = '/nonexistent/override.py'
    expect(
      resolveStructureRecognitionScript({ resourcesPath: '/tmp/ps-test/resources' }, {
        PURESCIENCE_STRUCTURE_RECOGNITION_SCRIPT: here
      } as NodeJS.ProcessEnv)
    ).toContain('resources')
    const packaged = resolveStructureRecognitionScript(
      { resourcesPath: '/tmp/ps-test/resources' },
      {} as NodeJS.ProcessEnv
    )
    expect(packaged.endsWith('engines/structure_recognition.py')).toBe(true)
  })
})

describe('resolveEnginePython', () => {
  it('returns undefined when no interpreter exists — the caller names that instead of guessing', () => {
    expect(
      resolveEnginePython('decimer', { dataRoots: ['/nope'] }, {} as NodeJS.ProcessEnv)
    ).toBeUndefined()
  })

  it('looks under each data root at the env the engine is provisioned in', () => {
    const root = '/tmp/ps-test-data'
    const expected = `${root}/runtime/envs/structure-recognition/bin/python`
    // 路径形状就是产品自己的命名环境约定；文件是否存在由真机决定，这里钉的是**去哪找**。
    const found = resolveEnginePython('decimer', { dataRoots: [root] }, {} as NodeJS.ProcessEnv)
    expect(found === undefined || found === expected).toBe(true)
    const molscribe = resolveEnginePython(
      'molscribe',
      { dataRoots: [root] },
      {} as NodeJS.ProcessEnv
    )
    expect(
      molscribe === undefined || molscribe.endsWith('structure-recognition-molscribe/bin/python')
    ).toBe(true)
  })
})

describe('recognizeFigureStructure', () => {
  const deps = (answers: unknown[]): { seen: string[][]; deps: StructureRecognitionDeps } => {
    const seen: string[][] = []
    return {
      seen,
      deps: {
        scriptPath: '/tmp/ps-test/structure_recognition.py',
        // `resolveEnginePython` 只接受**真实存在**的解释器（不假装缺的也在），所以这里用 node 自己的
        // 可执行路径 —— 它在任何机器上都存在。曾经这里指向我本机某个文件：本机跑得过，CI 里不存在，
        // 于是引擎被解析成 undefined、排好的读数根本没被消费，断言就飘了（CI 抓到的正是这个）。
        pythonFor: {
          decimer: process.execPath,
          molscribe: process.execPath
        },
        runJson: async (_python: string, args: readonly string[]) => {
          seen.push([...args])
          return (
            answers.shift() ?? { ok: false, reason: 'runner-failed', detail: 'no answer queued' }
          )
        }
      }
    }
  }

  it('agrees when both engines read the same structure, and fingerprints the input', async () => {
    const { deps: d, seen } = deps([
      rasterizeOk,
      engineOk('CCO', 'DECIMER 2.8.0'),
      canonicalOk('CCO'),
      engineOk('OCC', 'MolScribe 1.1.1'),
      canonicalOk('CCO')
    ])
    const result = await recognizeFigureStructure({
      pdfPath: '/tmp/paper.pdf',
      page: 7,
      bbox: { x: 1, y: 2, width: 3, height: 4 },
      deps: d
    })

    expect(result.outcome.state).toBe('agreed')
    if (result.outcome.state !== 'agreed') return
    expect(result.outcome.canonical).toBe('CCO')
    expect(result.outcome.engines.map((engine) => engine.revision)).toEqual([
      'DECIMER 2.8.0',
      'MolScribe 1.1.1'
    ])
    expect(result.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.rasterPixels).toEqual({ width: 640, height: 480 })
    // 渲染一次，两台引擎各一次，再各规范化一次
    expect(seen.filter((args) => args.includes('rasterize'))).toHaveLength(1)
    expect(seen.filter((args) => args.includes('recognize'))).toHaveLength(2)
  })

  it('refuses by name when only one engine is installed, keeping each reading', async () => {
    const { deps: d } = deps([
      rasterizeOk,
      engineOk('CCO', 'DECIMER 2.8.0'),
      canonicalOk('CCO'),
      {
        ok: false,
        engine: 'molscribe',
        reason: 'engine-unavailable',
        detail: 'ModuleNotFoundError: molscribe'
      }
    ])
    const result = await recognizeFigureStructure({
      pdfPath: '/tmp/paper.pdf',
      page: 1,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      deps: d
    })

    expect(result.outcome.state).toBe('refused')
    if (result.outcome.state !== 'refused') return
    expect(result.outcome.reason).toBe('recognizer-single-engine')
    expect(result.outcome.readings).toHaveLength(2)
  })

  it('refuses a disagreement rather than picking the first answer', async () => {
    const { deps: d } = deps([
      rasterizeOk,
      engineOk('CCO', 'DECIMER 2.8.0'),
      canonicalOk('CCO'),
      engineOk('c1ccccc1', 'MolScribe 1.1.1'),
      canonicalOk('c1ccccc1', 'C6H6')
    ])
    const result = await recognizeFigureStructure({
      pdfPath: '/tmp/paper.pdf',
      page: 2,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      deps: d
    })
    expect(result.outcome.state).toBe('refused')
    if (result.outcome.state !== 'refused') return
    expect(result.outcome.reason).toBe('recognizer-disagreement')
  })

  it('keeps a runner failure as a named reason and still reports the raster reading', async () => {
    const { deps: d } = deps([
      rasterizeOk,
      { ok: false, reason: 'runner-failed', detail: 'no answer within 180000ms' },
      { ok: false, reason: 'runner-failed', detail: 'no answer within 180000ms' }
    ])
    const result = await recognizeFigureStructure({
      pdfPath: '/tmp/paper.pdf',
      page: 3,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      deps: d
    })
    expect(result.outcome.state).toBe('refused')
    if (result.outcome.state !== 'refused') return
    expect(result.outcome.reason).toBe('recognizer-unavailable')
    const details = result.outcome.readings.map((reading) =>
      reading.state === 'failed' ? reading.detail : 'read'
    )
    expect(details.every((detail) => detail.includes('no answer within'))).toBe(true)
  })

  it('says the figure could not be rendered instead of pretending no engine exists', async () => {
    const { deps: d } = deps([
      { ok: false, reason: 'rasterizer-unavailable', detail: 'ModuleNotFoundError: pypdfium2' }
    ])
    const result = await recognizeFigureStructure({
      pdfPath: '/tmp/paper.pdf',
      page: 4,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      deps: d
    })
    expect(result.raster.ok).toBe(false)
    expect(result.outcome.state).toBe('refused')
    if (result.outcome.state !== 'refused') return
    expect(
      result.outcome.readings.every(
        (reading) => reading.state !== 'read' && reading.detail.includes('could not be rendered')
      )
    ).toBe(true)
  })
})
