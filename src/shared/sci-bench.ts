// SciBench-Local v0 (v1.53 unit 7): a machine-checkable acceptance benchmark for the five
// scientific-capability upgrades. Each case is drawn from a real failure the product exhibited
// (no-GPU compute dead-ends, ASCII-instead-of-figure, mislabeled log axes, restarts redoing work,
// literature imports without provenance) and each expectation is a deterministic rule over a
// trace, so a fix is only "done" when the trace actually shows the new behaviour.
//
// Scope honesty: v0 evaluates *traces* (transcripts, artifacts, tool calls) — it does not run the
// agent itself. v1 will replay recorded sessions through the same rules.

export const SCI_BENCH_RULES = [
  // compute ladder (G1/G2)
  'compute-route-or-state-not-computed',
  'no-unprovenanced-quantity',
  // figure discipline (G3)
  'figure-review-invoked',
  'figure-ships-image-and-script',
  'log-axis-ticks-declared',
  // checkpoint (G4)
  'checkpoint-loaded-before-work',
  'checkpoint-saved-after-step',
  // literature workflow
  'batch-import-reports-progress',
  'gbt7714-citation-shape',
  // large omics data (v1.54)
  'subset-scope-labelled',
  'full-run-proposal-requires-approval'
] as const
export type SciBenchRule = (typeof SCI_BENCH_RULES)[number]

export type SciBenchGap =
  | 'compute-ladder'
  | 'figure-discipline'
  | 'checkpoint'
  | 'literature-import'
  | 'citation-export'
  | 'large-data'

export type SciBenchCase = {
  id: string
  title: string
  gap: SciBenchGap
  /** The real-world failure this case encodes. */
  origin: string
  /** The user-facing request the trace should answer. */
  prompt: string
  expectations: { rule: SciBenchRule; description: string }[]
}

export type SciBenchTrace = {
  /** Everything the agent said/wrote in the session (plain text). */
  transcript: string
  /** Artifact paths produced during the session. */
  artifacts?: string[]
  /** Tool invocations in order, optionally with structured arguments. */
  toolCalls?: { name: string; args?: Record<string, unknown> }[]
}

export type SciBenchFinding = {
  rule: SciBenchRule
  passed: boolean
  detail: string
}

export type SciBenchResult = {
  caseId: string
  passed: boolean
  findings: SciBenchFinding[]
}

const callNames = (trace: SciBenchTrace): string[] =>
  (trace.toolCalls ?? []).map((call) => call.name)

const hasCall = (trace: SciBenchTrace, name: string): boolean => callNames(trace).includes(name)

const indexOfCall = (trace: SciBenchTrace, name: string): number => callNames(trace).indexOf(name)

// A number that claims to be a computed quantity without an engine/version/parameter trail.
const UNPROVENANCED_QUANTITY = /(ΔΔG|ddG|IC50|Kd|pLDDT|RMSD)\s*[=:≈]?\s*-?\d/i
const PROVENANCE_MARKERS =
  /(provenance|source|via|using|engine|version|parameters|with\s+\w+\s+v?\d)/i
const NOT_COMPUTED =
  /(not computed|未计算|cannot compute|no compute|requires .{0,40}(engine|host|gpu))/i
const ROUTE_MARKERS = /(job .{0,30}(approved|submitted|proposed)|slurm|ssh host|remote compute)/i
const DB_PREDICTION_LABELED =
  /(alphafold|pdb|predicted|预测).{0,60}(not experimental|预测|predicted|database)/i

export const evaluateSciBenchTrace = (
  benchCase: SciBenchCase,
  trace: SciBenchTrace
): SciBenchResult => {
  const text = `${trace.transcript}\n${(trace.artifacts ?? []).join('\n')}`
  const findings: SciBenchFinding[] = []
  const rules = new Set(benchCase.expectations.map((expectation) => expectation.rule))

  if (rules.has('compute-route-or-state-not-computed')) {
    const routed = ROUTE_MARKERS.test(text)
    const labeledPrediction = DB_PREDICTION_LABELED.test(text)
    const declaredMissing = NOT_COMPUTED.test(text)
    findings.push({
      rule: 'compute-route-or-state-not-computed',
      passed: routed || labeledPrediction || declaredMissing,
      detail: routed
        ? 'trace shows a compute route (approval/scheduler/host)'
        : labeledPrediction
          ? 'trace uses a database prediction and labels it as such'
          : declaredMissing
            ? 'trace states the quantity is not computed and why'
            : 'no compute route, no labeled prediction, and no explicit "not computed" statement'
    })
  }

  if (rules.has('no-unprovenanced-quantity')) {
    const claims = trace.transcript.split(/(?<=[.;。；])\s*/)
    const offenders = claims.filter(
      (sentence) => UNPROVENANCED_QUANTITY.test(sentence) && !PROVENANCE_MARKERS.test(sentence)
    )
    findings.push({
      rule: 'no-unprovenanced-quantity',
      passed: offenders.length === 0,
      detail:
        offenders.length === 0
          ? 'every quantity carries a provenance marker'
          : `${offenders.length} quantity claim(s) without provenance, e.g. "${offenders[0].trim().slice(0, 120)}"`
    })
  }

  if (rules.has('figure-review-invoked')) {
    const invoked = hasCall(trace, 'figure_review')
    findings.push({
      rule: 'figure-review-invoked',
      passed: invoked,
      detail: invoked ? 'figure_review was invoked' : 'figure_review was never invoked'
    })
  }

  if (rules.has('figure-ships-image-and-script')) {
    const artifacts = trace.artifacts ?? []
    const hasImage = artifacts.some((path) => /\.png$/i.test(path))
    const hasScript = artifacts.some((path) => /\.py$/i.test(path))
    const mentionsFigure = /(figure|plot|chart|图)/i.test(text)
    const passed = !mentionsFigure || (hasImage && hasScript)
    findings.push({
      rule: 'figure-ships-image-and-script',
      passed,
      detail: passed
        ? 'figure ships both its image and the plotting script'
        : `figure artifacts incomplete (image=${hasImage}, script=${hasScript})`
    })
  }

  if (rules.has('log-axis-ticks-declared')) {
    const mentionsLog = /log[- ]?(scale|axis)|对数轴/i.test(text)
    const declaresTicks = /(tick|刻度).{0,80}(0\.0|0\.1|0\.5|1|10|100)/i.test(text)
    const passed = !mentionsLog || declaresTicks
    findings.push({
      rule: 'log-axis-ticks-declared',
      passed,
      detail: passed
        ? 'log axes come with their tick labels declared'
        : 'a log axis is mentioned without declaring its tick labels'
    })
  }

  if (rules.has('checkpoint-loaded-before-work')) {
    const loadIndex = indexOfCall(trace, 'checkpoint_load')
    const firstHeavyCall = Math.min(
      ...['run_python', 'notebook_run', 'compute_submit', 'figure_review']
        .map((name) => indexOfCall(trace, name))
        .filter((index) => index >= 0),
      Number.POSITIVE_INFINITY
    )
    const passed = loadIndex >= 0 && loadIndex < firstHeavyCall
    findings.push({
      rule: 'checkpoint-loaded-before-work',
      passed,
      detail: passed
        ? 'checkpoint_load ran before the first heavy step'
        : loadIndex < 0
          ? 'checkpoint_load was never called on a resumable run'
          : 'checkpoint_load ran after work had already started'
    })
  }

  if (rules.has('checkpoint-saved-after-step')) {
    const saved = hasCall(trace, 'checkpoint_save')
    findings.push({
      rule: 'checkpoint-saved-after-step',
      passed: saved,
      detail: saved
        ? 'durable results were written back to the checkpoint'
        : 'no checkpoint_save: a restart would redo the work'
    })
  }

  if (rules.has('batch-import-reports-progress')) {
    const attachCalls = callNames(trace).filter(
      (name) => name === 'references.attachPdf' || name === 'references.add'
    ).length
    const reportsProgress = /(\d+\s*\/\s*\d+|progress|进度)/i.test(text)
    const passed = attachCalls >= 2 && reportsProgress
    findings.push({
      rule: 'batch-import-reports-progress',
      passed,
      detail: passed
        ? `batch import of ${attachCalls} files reports progress`
        : `batch import lacks evidence (calls=${attachCalls}, progress=${reportsProgress})`
    })
  }

  if (rules.has('gbt7714-citation-shape')) {
    const gbtShape = /\[J\]\s*\.|\[EB\/OL\]\s*\./.test(text) && /(, 等|et al\.)/.test(text)
    findings.push({
      rule: 'gbt7714-citation-shape',
      passed: gbtShape,
      detail: gbtShape
        ? 'citations follow the GB/T 7714-2015 sequential shape'
        : 'citations do not show the GB/T 7714-2015 shape ([J]/[EB/OL] + 等/et al.)'
    })
  }

  if (rules.has('subset-scope-labelled')) {
    const labelsSubset = /基于\s*\d+\s*\/\s*(\d+|全部)\s*降采样/.test(text)
    const mentionsSubset = /(降采样|downsampl|subsample)/i.test(text)
    const passed = !mentionsSubset || labelsSubset
    findings.push({
      rule: 'subset-scope-labelled',
      passed,
      detail: passed
        ? 'every downsampled read carries its N/M scope label'
        : 'a downsampled read is discussed without the N/M scope label (G6)'
    })
  }

  if (rules.has('full-run-proposal-requires-approval')) {
    const approvalStated = /(需人工批准|等待批准|awaits? approval|pending approval)/i.test(text)
    const resultLabels = /(引擎与版本|关键参数|数据范围：全量)/.test(text)
    const claimsDone = /(已提交|已运行|submitted and ran)/.test(text)
    const passed = approvalStated && resultLabels && !claimsDone
    findings.push({
      rule: 'full-run-proposal-requires-approval',
      passed,
      detail: passed
        ? 'full run is proposed with an explicit approval gate and required result labels'
        : !approvalStated
          ? 'no approval gate stated for the full run (G1)'
          : claimsDone
            ? 'the trace claims the job was submitted without stating approval'
            : 'the proposal omits the labels the finished result must carry'
    })
  }

  return {
    caseId: benchCase.id,
    passed: findings.every((finding) => finding.passed),
    findings
  }
}

export const SCI_BENCH_CASES: SciBenchCase[] = [
  {
    id: 'shank2-compute-ladder',
    title: '结构生物学量化请求在无 GPU 机器上的处置',
    gap: 'compute-ladder',
    origin: 'SHANK2 任务：本机无 GPU 时直接降级为示意图与"距离 57.5 Å"的定性描述',
    prompt: '计算 SHANK2 PDZ 结构域的 ΔΔG，并给出可复现的数值结果；本机没有可用 GPU。',
    expectations: [
      {
        rule: 'compute-route-or-state-not-computed',
        description: '必须走 compute 决策链：提议 job 待批 / 标注数据库预测 / 明说未计算'
      },
      {
        rule: 'no-unprovenanced-quantity',
        description: '任何数值都必须带引擎/版本/参数来源；禁止凭空给出 ΔΔG'
      }
    ]
  },
  {
    id: 'egfr-figure-discipline',
    title: '出版级图表：对数轴刻度与源文件双产物',
    gap: 'figure-discipline',
    origin: 'EGFR 任务：log 轴 0.4 被标成 0.05；图表以 ASCII 表格交付',
    prompt: '为 EGFR 剂量-反应数据出图，log 轴，交付可投稿的图表文件。',
    expectations: [
      { rule: 'figure-review-invoked', description: '出图前必须跑 figure_review' },
      {
        rule: 'figure-ships-image-and-script',
        description: '同时交付 .png 与 .py，保证可复现'
      },
      { rule: 'log-axis-ticks-declared', description: 'log 轴必须申报刻度标签，防错位标注' }
    ]
  },
  {
    id: 'multi-step-checkpoint-resume',
    title: '长链任务的检查点恢复',
    gap: 'checkpoint',
    origin: '序列→结构→单细胞→药物多步任务，重启后从零重做（重检索、重装包）',
    prompt: '继续上周的 SHANK2 多步分析：已解析 UniProt、已装好环境，从单细胞这一步接着做。',
    expectations: [
      {
        rule: 'checkpoint-loaded-before-work',
        description: '开工前先 checkpoint_load 挂载已验证结果'
      },
      { rule: 'checkpoint-saved-after-step', description: '耐久步骤完成后 checkpoint_save' }
    ]
  },
  {
    id: 'literature-batch-pdf-import',
    title: '文献库批量 PDF 入册',
    gap: 'literature-import',
    origin: '文献库只能一条一条挂 PDF，缺进度/取消与批量能力',
    prompt: '把这批 6 篇 PDF 一起入册到项目文献库，并挂好附件。',
    expectations: [
      { rule: 'batch-import-reports-progress', description: '批量导入必须有进度反馈/取消路径' },
      {
        rule: 'no-unprovenanced-quantity',
        description: '从 PDF 提取的数值必须带来源（文件名/页码）'
      }
    ]
  },
  {
    id: 'gbt7714-export',
    title: '中文学术引文导出',
    gap: 'citation-export',
    origin: '引用只能导出通用格式，中文期刊投稿需 GB/T 7714-2015 顺序编码制',
    prompt: '把当前收藏夹里的文献导出成 GB/T 7714-2015 顺序编码制引文清单。',
    expectations: [
      {
        rule: 'gbt7714-citation-shape',
        description: '引文形态必须是 [J]/[EB/OL] + 等/et al. 的国标样式'
      }
    ]
  },
  {
    id: 'omics-large-file-preview',
    title: '大文件组学数据的先探后算',
    gap: 'large-data',
    origin:
      '单细胞/变异大文件过去要么直接载入吃满内存，要么用降采样结论当最终结果交付（无范围标注）',
    prompt: '预览这个 2 万细胞的 h5ad，先做降采样分析；如果结论需要全量，给出全量方案。',
    expectations: [
      {
        rule: 'subset-scope-labelled',
        description: '任何降采样读取都必须带「基于 N/M 降采样」范围标注（G6）'
      },
      {
        rule: 'full-run-proposal-requires-approval',
        description: '全量作业只能作为提案（等待批准），并声明结果必须携带的标注（G1）'
      },
      {
        rule: 'no-unprovenanced-quantity',
        description: '从大文件得到的数值同样必须带来源'
      }
    ]
  }
]

export const summarizeSciBench = (
  results: readonly SciBenchResult[]
): { total: number; passed: number; failures: SciBenchResult[] } => ({
  total: results.length,
  passed: results.filter((result) => result.passed).length,
  failures: results.filter((result) => !result.passed)
})
