import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { NotebookRunDocument, NotebookRunRecord } from '../../shared/notebook'
import { SkillCreator } from './skill-creator'
import { createMethodSkillCompiler } from './method-skill-compiler'

const SCRIPT = 'import pandas as pd\nprint(pd.__version__)'

const run = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'run-7',
  cellId: 'cell-2',
  source: 'agent',
  kernelKind: 'python',
  script: SCRIPT,
  status: 'completed',
  startedAt: 1_700_000_000_000,
  executionCount: 1,
  text: { stdout: '2.2.0\n', stderr: '', traceback: '', plain: ['2.2.0'] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

const document = (projectName: string, runs: NotebookRunRecord[]): NotebookRunDocument => ({
  version: 1,
  projectName,
  sessionId: 'session-1',
  workspaceCwd: '/workspaces/session-1',
  notebookSessionRoot: `/notebooks/${projectName}/session-1`,
  dataRoot: `/notebooks/${projectName}/session-1/data`,
  kernel: { language: 'python', kernelName: 'python3', runtimeRoot: '/runtime', lastKnownStatus: 'idle' },
  runs,
  updatedAt: 1_700_000_000_000
})

const temporary: string[] = []

const makeConfigDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'method-skill-'))
  temporary.push(dir)
  return dir
}

afterEach(async () => {
  while (temporary.length > 0) await rm(temporary.pop()!, { recursive: true, force: true })
})

describe('createMethodSkillCompiler', () => {
  it('writes a skill whose frontmatter carries the run it came from', async () => {
    const configDir = await makeConfigDir()
    const compiler = createMethodSkillCompiler({
      skillCreator: new SkillCreator({ configDir }),
      repository: { findExisting: async () => document('p1', [run()]) },
      listProjectIds: async () => ['p1']
    })

    const outcome = await compiler.compileFromRun({
      sessionId: 'session-1',
      runId: 'run-7',
      name: 'check-pandas'
    })

    expect(outcome.state).toBe('created')
    if (outcome.state !== 'created') return
    expect(outcome.kind).toBe('procedure')
    expect(outcome.projectId).toBe('p1')

    const written = await readFile(join(configDir, 'skills', 'check-pandas', 'SKILL.md'), 'utf8')
    // The record IS the method: the steps in the document are the cell as it ran.
    expect(written).toContain(SCRIPT)
    expect(written).toContain('run: run-7')
    // Source is checkable after export/import too — it lives in the frontmatter, not in a second store.
    expect(written).toContain('trust: "unverified"')
    expect(written).toContain('trust_kind: "procedure"')
    expect(written).toContain('trust_origin: "run-7"')
    expect(written).toContain(outcome.fingerprint)
  })

  it('refuses by name when the record cannot be located, and says what it did read', async () => {
    const configDir = await makeConfigDir()
    const compiler = createMethodSkillCompiler({
      skillCreator: new SkillCreator({ configDir }),
      repository: { findExisting: async () => null },
      listProjectIds: async () => ['p1', 'p2']
    })

    const outcome = await compiler.compileFromRun({
      sessionId: 'session-1',
      runId: 'run-missing',
      name: 'check-pandas'
    })

    expect(outcome).toMatchObject({ state: 'refused', reason: 'not-found' })
    if (outcome.state !== 'refused') return
    expect(outcome.detail).toContain('Run run-missing is not in session session-1')
    // An unreadable record must not read as "there is none": it is counted separately.
    expect(outcome.detail).toContain('for any of the 2 projects that could be read')
  })

  it('refuses an ambiguous run instead of picking a project', async () => {
    const configDir = await makeConfigDir()
    const compiler = createMethodSkillCompiler({
      skillCreator: new SkillCreator({ configDir }),
      repository: {
        findExisting: async (projectId) => document(projectId, projectId === 'p3' ? [] : [run()])
      },
      listProjectIds: async () => ['p1', 'p2', 'p3']
    })

    const outcome = await compiler.compileFromRun({
      sessionId: 'session-1',
      runId: 'run-7',
      name: 'check-pandas'
    })

    expect(outcome).toMatchObject({ state: 'refused', reason: 'ambiguous' })
    if (outcome.state !== 'refused') return
    expect(outcome.detail).toContain('exists in 2 projects')
  })

  it('counts a project whose record cannot be read, instead of reporting none', async () => {
    const configDir = await makeConfigDir()
    const compiler = createMethodSkillCompiler({
      skillCreator: new SkillCreator({ configDir }),
      repository: {
        findExisting: async (projectId) => {
          if (projectId === 'broken') throw new Error('Invalid notebook path segment: broken/../x')
          return null
        }
      },
      listProjectIds: async () => ['broken', 'p1']
    })

    const outcome = await compiler.compileFromRun({
      sessionId: 'session-1',
      runId: 'run-7',
      name: 'check-pandas'
    })

    expect(outcome).toMatchObject({ state: 'refused', reason: 'not-found' })
    if (outcome.state !== 'refused') return
    expect(outcome.detail).toContain('1 of 2 project records could not be read')
  })

  it('hands the compiler refusals through, and the creator its own refusal reason', async () => {
    const configDir = await makeConfigDir()
    const compiler = createMethodSkillCompiler({
      skillCreator: new SkillCreator({ configDir }),
      repository: { findExisting: async () => document('p1', [run({ script: '  ' })]) },
      listProjectIds: async () => ['p1']
    })

    const noSteps = await compiler.compileFromRun({
      sessionId: 'session-1',
      runId: 'run-7',
      name: 'check-pandas'
    })
    expect(noSteps).toMatchObject({ state: 'refused', reason: 'no-steps' })

    const badName = createMethodSkillCompiler({
      skillCreator: new SkillCreator({ configDir }),
      repository: { findExisting: async () => document('p1', [run()]) },
      listProjectIds: async () => ['p1']
    })
    const refused = await badName.compileFromRun({
      sessionId: 'session-1',
      runId: 'run-7',
      name: 'Not A Skill Name'
    })
    expect(refused).toMatchObject({ state: 'refused', reason: 'write-refused' })
    if (refused.state !== 'refused') return
    expect(refused.detail).toContain('Invalid skill name')
  })

  it('treats a blank run id as a missing record, not as "the first run"', async () => {
    const configDir = await makeConfigDir()
    const compiler = createMethodSkillCompiler({
      skillCreator: new SkillCreator({ configDir }),
      repository: { findExisting: async () => document('p1', [run()]) },
      listProjectIds: async () => ['p1']
    })

    const outcome = await compiler.compileFromRun({
      sessionId: 'session-1',
      runId: '   ',
      name: 'check-pandas'
    })
    expect(outcome).toMatchObject({ state: 'refused', reason: 'not-found' })
  })
})
