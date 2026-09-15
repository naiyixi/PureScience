import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Guard: background result delivery belongs to the MAIN process (src/main/background-delivery). The
// renderer used to decide whether a finished job deserved an analysis turn, which stranded the result
// whenever no window was open and allowed two paths to write two turns for one batch. This test fails if
// a renderer module starts owning delivery again.
const rendererRoot = resolve(__dirname, '../..')

const productionSources = (): readonly string[] => {
  const paths: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.[cm]?tsx?$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)) {
        paths.push(path)
      }
    }
  }
  visit(rendererRoot)
  return paths
}

describe('background result delivery ownership', () => {
  it('leaves delivery to the main process: no renderer module wires an analysis turn', () => {
    const offenders = productionSources().filter((path) =>
      /job-analysis-trigger|useJobAnalysisEffect|buildAnalysisPrompt/.test(
        readFileSync(path, 'utf8')
      )
    )

    expect(offenders).toEqual([])
  })

  it('has no delivery module left behind in the renderer', () => {
    const names = productionSources().map((path) => path.split('/').pop())

    expect(names).not.toContain('useJobAnalysisEffect.ts')
    expect(names).not.toContain('job-analysis-trigger.ts')
  })
})
