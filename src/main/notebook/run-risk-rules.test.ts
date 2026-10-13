import { describe, expect, it } from 'vitest'

import {
  evaluateNotebookRunRisk,
  NOTEBOOK_RUN_RISK_RECIPE,
  NOTEBOOK_RUN_RISK_RULE_SET_VERSION,
  type RunRiskRuleId
} from './run-risk-rules'

const hitIds = (source: string): RunRiskRuleId[] =>
  evaluateNotebookRunRisk(source).hits.map((hit) => hit.ruleId)

describe('evaluateNotebookRunRisk', () => {
  it('names the delete rule with the line to look at', () => {
    const source = ['import shutil', "shutil.rmtree('/tmp/run')"].join('\n')
    const assessment = evaluateNotebookRunRisk(source)
    expect(assessment.verdict).toBe('review')
    expect(assessment.hits).toEqual([
      {
        ruleId: 'fs-delete',
        ruleVersion: 'v1',
        lines: [2],
        excerpts: ["shutil.rmtree('/tmp/run')"]
      }
    ])
  })

  it('names the overwrite rule, and stays quiet about a plain read', () => {
    expect(hitIds("open('out.txt', 'w').write('x')")).toEqual(['fs-overwrite'])
    expect(hitIds("df.to_csv('out.csv')")).toEqual(['fs-overwrite'])
    expect(hitIds("df.to_csv('log.csv', mode='a')")).toEqual([])
    expect(hitIds("with open('a.txt', 'r') as handle:\n    print(handle.read())")).toEqual([])
  })

  it('names the shell rule', () => {
    expect(hitIds('subprocess.run(["rm", "-rf", "/tmp/x"])')).toEqual(['shell-exec'])
    expect(hitIds('!sudo apt-get install -y curl')).toEqual(['shell-exec'])
  })

  it('reports each rule that fired, with its own lines', () => {
    const source = ["shutil.rmtree('/tmp/x')", "df.to_csv('out.csv')", 'subprocess.run(["ls"])']
    const joined = source.join('\n')
    const assessment = evaluateNotebookRunRisk(joined)
    expect(hitIds(joined)).toEqual(['fs-delete', 'fs-overwrite', 'shell-exec'])
    expect(assessment.hits.map((hit) => hit.lines)).toEqual([[1], [2], [3]])
  })

  it('treats an rm -rf run through the shell as the deletion it is', () => {
    expect(hitIds('!rm -rf /tmp/data')).toContain('fs-delete')
    expect(hitIds('!sudo rm -rf /tmp/data')).toContain('fs-delete')
  })

  it('calls out an allocation past the floor and leaves a small one alone', () => {
    expect(hitIds('x = np.zeros((20000, 20000))')).toEqual(['large-allocation'])
    expect(hitIds('x = np.zeros((10, 10))')).toEqual([])
    // The floor reads the line's own tuple; a variable is not guessed at.
    expect(hitIds('shape = load_shape()\nx = np.zeros(shape)')).toEqual([])
  })

  it('allows a cell that asks for nothing on the list', () => {
    const assessment = evaluateNotebookRunRisk('total = sum(range(10))\nprint(total)')
    expect(assessment.verdict).toBe('allow')
    expect(assessment.hits).toEqual([])
  })

  it('produces a receipt a third party can recompute', () => {
    const first = evaluateNotebookRunRisk("shutil.rmtree('/tmp/run')")
    const again = evaluateNotebookRunRisk("shutil.rmtree('/tmp/run')")
    expect(first.codeHash).toBe(again.codeHash)
    expect(first.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(first.ruleSetVersion).toBe(NOTEBOOK_RUN_RISK_RULE_SET_VERSION)
    expect(evaluateNotebookRunRisk("shutil.rmtree('/tmp/other')").codeHash).not.toBe(first.codeHash)
    expect(NOTEBOOK_RUN_RISK_RECIPE).toContain('sha256')
    expect(NOTEBOOK_RUN_RISK_RECIPE).toContain(NOTEBOOK_RUN_RISK_RULE_SET_VERSION)
  })

  it('has no dead rule: every rule id fires on at least one sample', () => {
    const samples = [
      "shutil.rmtree('/tmp/run')",
      "open('out.txt', 'w')",
      'subprocess.run(["ls"])',
      'x = np.ones((20000, 20000))'
    ]
    const fired = new Set(samples.flatMap(hitIds))
    for (const id of ['fs-delete', 'fs-overwrite', 'shell-exec', 'large-allocation'] as const) {
      expect(fired.has(id), `rule ${id} never fires`).toBe(true)
    }
  })
})
