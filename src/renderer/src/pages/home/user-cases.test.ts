// The user-case rules, tested where they can be wrong: naming (a case is not its folder), standing (a
// case is earned by files, not by a session existing), field classification, ordering and search.
import { describe, expect, it } from 'vitest'

import type { CaseFootprint, UserCase } from './user-cases'
import {
  CASE_MINIMUMS,
  classifyDomain,
  collectKinds,
  deriveCaseName as derive,
  filterCases,
  formatCaseBytes,
  humanizeStem,
  judgeStanding,
  sortCases
} from './user-cases'

const footprint = (overrides: Partial<CaseFootprint> = {}): CaseFootprint => ({
  sessions: 1,
  artifactCount: 0,
  uploadCount: 0,
  fileCount: 0,
  totalBytes: 0,
  kinds: [],
  ...overrides
})

const userCase = (overrides: Partial<UserCase> = {}): UserCase => ({
  projectId: 'p1',
  name: 'A case',
  nameSource: 'derived',
  domain: 'general',
  standing: 'conversation-only',
  footprint: footprint(),
  files: [],
  ...overrides
})

describe('deriveCaseName', () => {
  it('prefers the project description over anything on disk', () => {
    const named = derive({
      projectId: 'unknown',
      projectName: 'test 5',
      description: 'EGFR TKI 选择性审计：三库交叉。第二句不进入标题。',
      files: ['report.md', 'heatmap.png']
    })
    expect(named).toEqual({ name: 'EGFR TKI 选择性审计：三库交叉', source: 'derived' })
  })

  it('prefers the name stored on the project over every code-side table', () => {
    const named = derive({
      projectId: 'cmt31dz5c0005wfeiv2aqqmsv',
      projectName: '化合物结构与靶点选择性审计',
      caseTitle: '  EGFR 选择性审计  ',
      description: '这段描述不该盖掉读者自己起的名字',
      files: ['report.md']
    })
    // A name that lives in the data wins and is reported as such: nothing here consults the shipped table.
    expect(named).toEqual({ name: 'EGFR 选择性审计', source: 'project' })
  })

  it('treats a blank stored name as "not named yet" and derives one', () => {
    const named = derive({
      projectId: 'unknown',
      projectName: 'test 5',
      caseTitle: '   ',
      description: 'EGFR TKI 选择性审计：三库交叉。',
      files: ['report.md']
    })
    expect(named).toEqual({ name: 'EGFR TKI 选择性审计：三库交叉', source: 'derived' })
  })

  it('uses a curated title when the machine has one, and says so', () => {
    const named = derive({
      projectId: 'cmt31dz5c0005wfeiv2aqqmsv',
      projectName: '化合物结构与靶点选择性审计',
      description: 'whatever',
      files: []
    })
    expect(named.source).toBe('curated')
    expect(named.name).toBe('EGFR TKI 选择性审计：三库交叉热图')
  })

  it('refuses to hand back the project name as the case name', () => {
    // The description is literally the folder name, and there is no usable filename: the case must fall
    // through to "unnamed" rather than echo the folder a second time.
    const named = derive({
      projectId: 'unknown',
      projectName: '分子对接',
      description: '分子对接',
      files: ['report.md', 'summary.json']
    })
    expect(named.name).toBe('')
    expect(named.source).toBe('derived')
  })

  it('falls back to the most descriptive filename, skipping generic stems and figure numbers', () => {
    const named = derive({
      projectId: 'unknown',
      projectName: 'project-42',
      description: '',
      files: ['report.md', 'fig1_trend.png', 'mtx_4dfr_pocket_report.md']
    })
    expect(named.name).toBe('Mtx 4dfr pocket report')
  })

  it('never invents a name out of a too-short stem', () => {
    const named = derive({
      projectId: 'unknown',
      projectName: 'x',
      description: '',
      files: ['a.png', 'b.csv']
    })
    expect(named.name).toBe('')
  })
})

describe('judgeStanding', () => {
  it('needs both enough artifacts and more than one kind', () => {
    expect(
      judgeStanding(
        footprint({ artifactCount: CASE_MINIMUMS.artifacts, kinds: ['md', 'png', 'csv'] })
      )
    ).toBe('reproducible')
    // Six artifacts of one kind is one artefact copied six times, not a reproducible case.
    expect(judgeStanding(footprint({ artifactCount: 20, kinds: ['md'] }))).toBe('conversation-only')
    // Many kinds, too few files: nothing to hand over.
    expect(judgeStanding(footprint({ artifactCount: 2, kinds: ['md', 'py', 'png'] }))).toBe(
      'conversation-only'
    )
  })

  it('treats a session with no files as conversation only', () => {
    expect(judgeStanding(footprint({ sessions: 3 }))).toBe('conversation-only')
  })
})

describe('classifyDomain', () => {
  it('reads the strongest signal in the file set', () => {
    expect(classifyDomain(['umap_batch.png', 'pbmc.h5ad', 'GSE24206.csv'])).toBe('omics')
    expect(classifyDomain(['pose_validation.png', 'target.pdb', 'docking_report.md'])).toBe(
      'structure'
    )
    expect(classifyDomain(['paper_Figure1.png', 'reproduction_report.md', 'x.bib'])).toBe(
      'literature'
    )
    expect(classifyDomain(['clinical_dossier.md', 'ind_timeline.png'])).toBe('clinical')
    expect(classifyDomain(['notes.md', 'summary.csv'])).toBe('general')
  })

  it('prefers omics over structure when both appear, because the single-cell files are the specific claim', () => {
    expect(classifyDomain(['protein.pdb', 'cells.h5ad'])).toBe('omics')
  })
})

describe('collectKinds / humanizeStem / formatCaseBytes', () => {
  it('collects distinct lower-case extensions only', () => {
    expect(collectKinds(['A.PNG', 'b.png', 'c.csv', 'README'])).toEqual(['csv', 'png'])
  })

  it('normalises separators without translating the wording', () => {
    expect(humanizeStem('Mtx_4DFR-report.md')).toBe('Mtx 4DFR report')
  })

  it('never prints a fabricated size for a missing read', () => {
    expect(formatCaseBytes(0)).toBe('0 MB')
    expect(formatCaseBytes(Number.NaN)).toBe('0 MB')
    expect(formatCaseBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatCaseBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB')
  })
})

describe('sortCases / filterCases', () => {
  const reproducible = userCase({
    projectId: 'a',
    name: 'Reproducible older',
    standing: 'reproducible',
    lastActive: 100,
    domain: 'omics',
    files: [{ name: 'cells.h5ad', size: 1, kind: 'h5ad' }]
  })
  const reproducibleNewer = userCase({
    projectId: 'b',
    name: 'Reproducible newer',
    standing: 'reproducible',
    lastActive: 900
  })
  const conversation = userCase({
    projectId: 'c',
    name: 'Conversation newest',
    standing: 'conversation-only',
    lastActive: 10_000
  })

  it('puts reproducible cases first, then recency — a chat cannot outrank a case', () => {
    expect(
      sortCases([conversation, reproducible, reproducibleNewer]).map((item) => item.projectId)
    ).toEqual(['b', 'a', 'c'])
  })

  it('searches the name, the field and the file names it would hand over', () => {
    expect(filterCases([reproducible], { query: 'reproducible' })).toHaveLength(1)
    expect(filterCases([reproducible], { query: 'omics' })).toHaveLength(1)
    expect(filterCases([reproducible], { query: 'h5ad' })).toHaveLength(1)
    expect(filterCases([reproducible], { query: 'protein' })).toHaveLength(0)
    expect(filterCases([reproducible, conversation], { domain: 'omics' })).toHaveLength(1)
    expect(filterCases([reproducible, conversation], { domain: 'all' })).toHaveLength(2)
  })
})
