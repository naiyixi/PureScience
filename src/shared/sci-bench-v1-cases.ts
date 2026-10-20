// SciBench-Local v1 · the seed corpus (v2.17 S1). Twelve cases, two per capability dimension.
//
// Every `origin` points at a real record in this repo — a verification note, a stress-test
// scorecard, or a v0 case that itself came from a real failure. Nothing here is invented: a case
// that cannot name where it came from does not belong in the benchmark.
//
// The prompts state the scientific goal only. No API name, no library name — the agent has to pick
// a method, and the checks only ask whether the science came out right.

import type { BenchCaseV1 } from './sci-bench-v1'

export const SCI_BENCH_V1_CASES: BenchCaseV1[] = [
  {
    id: 'structure-source-grounded',
    title: '结构结论必须有来源，预测不得冒充实验结构',
    dimension: 'tool_grounding',
    origin: 'docs/demo-verification/kras-pdb-structures-verification.md',
    prompt: 'KRAS G12C 有没有可用的三维结构？如果只有预测，请说明它是什么。',
    checks: [
      {
        kind: 'calls-tool',
        id: 'structure-fetched',
        dimension: 'tool_grounding',
        description: '结构来自真实数据库或预测服务，而不是凭记忆描述',
        tool: 'alphafold_get_prediction'
      },
      {
        kind: 'transcript-matches',
        id: 'experimental-vs-predicted',
        dimension: 'biological_plausibility',
        description: '预测结构被显式标注为预测',
        pattern: '(预测|predicted).{0,80}(非实验|not experimental|实验结构)',
        mustMatch: true
      },
      {
        kind: 'numbers-provenanced',
        id: 'plddt-provenanced',
        dimension: 'quantitative_quality',
        description: 'pLDDT 等数值带来源'
        // covered by numbers-provenanced; kept as its own check id for reporting
      }
    ]
  },
  {
    id: 'citation-chain-grounded',
    title: '文献结论要能落回可验证的引用',
    dimension: 'tool_grounding',
    origin: 'docs/demo-verification/egfr-t790m-dossier-verification.md',
    prompt: 'EGFR T790M 的第三代抑制剂证据链是什么？给出可核对出处。',
    checks: [
      {
        kind: 'calls-tool',
        id: 'literature-searched',
        dimension: 'tool_grounding',
        description: '引用来自真实检索',
        tool: 'search_articles'
      },
      {
        kind: 'citations-resolved',
        id: 'citations-resolve',
        dimension: 'quantitative_quality',
        description: '每条引用可解析且支撑其论断'
      },
      {
        kind: 'transcript-matches',
        id: 'no-ghost-citation',
        dimension: 'data_integrity',
        description: '不得出现"据文献"却不给具体出处',
        pattern: '(据文献|studies show|已有研究表明)(?!(.{0,200}(PMID|DOI|doi)))',
        mustMatch: false
      }
    ]
  },
  {
    id: 'omics-preview-subset-labelled',
    title: '大文件降采样必须标注范围',
    dimension: 'data_integrity',
    origin: 'src/shared/sci-bench.ts#omics-large-file-preview',
    prompt: '这个 h5ad 有多少细胞、多少基因？先给结论再决定是否全量分析。',
    checks: [
      {
        kind: 'transcript-matches',
        id: 'subset-scope',
        dimension: 'data_integrity',
        description: '子集结论标注"基于 N/M"',
        pattern: '基于\\s*\\d+\\s*/\\s*\\d+|subset|降采样',
        mustMatch: true
      },
      {
        kind: 'transcript-matches',
        id: 'full-run-not-claimed',
        dimension: 'data_integrity',
        description: '未全量前不得把子集结论当全量',
        pattern: '(全量(已)?完成|full (dataset|run) (is )?complete)',
        mustMatch: false
      },
      {
        kind: 'numbers-provenanced',
        id: 'counts-provenanced',
        dimension: 'quantitative_quality',
        description: '细胞/基因数带来源'
      }
    ]
  },
  {
    id: 'missing-input-prebrief',
    title: '缺输入要早说，不能留到结论里',
    dimension: 'data_integrity',
    origin: 'src/shared/sci-bench.ts#missing-input-prebrief',
    prompt: '帮我算一下这个靶点的 ΔΔG。',
    checks: [
      {
        kind: 'early-turn-matches',
        id: 'missing-stated-early',
        dimension: 'data_integrity',
        description: '第一轮就说明缺什么',
        pattern: '(缺|没有|not found|missing|需要.{0,20}(结构|序列|文件))',
        withinTurns: 1
      },
      {
        kind: 'transcript-matches',
        id: 'not-computed-stated',
        dimension: 'methodological_robustness',
        description: '明说"未计算"而不是给一个假数',
        pattern: '(未计算|not computed|cannot compute)',
        mustMatch: true
      },
      {
        kind: 'numbers-provenanced',
        id: 'no-fake-ddg',
        dimension: 'quantitative_quality',
        description: '没有来源的 ΔΔG 不得出现'
      }
    ]
  },
  {
    id: 'checkpoint-resume-order',
    title: '恢复工作时先装载检查点再做新计算',
    dimension: 'object_plumbing',
    origin: 'src/shared/sci-bench.ts#multi-step-checkpoint-resume',
    prompt: '接着上次那批差异表达的结果往下做富集分析。',
    checks: [
      {
        kind: 'call-order',
        id: 'load-before-work',
        dimension: 'object_plumbing',
        description: '先装载检查点，再执行新步骤',
        before: 'checkpoint_load',
        after: 'checkpoint_save'
      },
      {
        kind: 'transcript-matches',
        id: 'resume-named',
        dimension: 'object_plumbing',
        description: '说明恢复了哪些已验证结果',
        pattern: '(恢复|resume|沿用).{0,40}(检查点|checkpoint|上次)',
        mustMatch: true
      },
      {
        kind: 'transcript-matches',
        id: 'no-silent-redo',
        dimension: 'data_integrity',
        description: '不得静默重跑已完成的步骤',
        pattern: '(重新从头|redo .{0,20}from scratch)',
        mustMatch: false
      }
    ]
  },
  {
    id: 'analysis-artifact-pairing',
    title: '图必须带着生成脚本一起交付',
    dimension: 'object_plumbing',
    origin: 'docs/demo-verification/assay-local-analysis-verification.md',
    prompt: '把这些化合物活性做成一张可以放进报告的图。',
    checks: [
      {
        kind: 'artifact-with-script',
        id: 'figure-with-script',
        dimension: 'object_plumbing',
        description: '图与生成脚本同批交付',
        artifact: '\\.png$',
        script: '\\.py$'
      },
      {
        kind: 'transcript-matches',
        id: 'figure-source-named',
        dimension: 'quantitative_quality',
        description: '说明图来自哪份数据',
        pattern: '(数据源|来自|source).{0,40}(\\.csv|\\.tsv|输入)',
        mustMatch: true
      },
      {
        kind: 'numbers-provenanced',
        id: 'summary-numbers-provenanced',
        dimension: 'quantitative_quality',
        description: '摘要统计带来源'
      }
    ]
  },
  {
    id: 'figure-axis-discipline',
    title: '对数轴与刻度必须自检',
    dimension: 'quantitative_quality',
    origin: 'src/shared/sci-bench.ts#egfr-figure-discipline',
    prompt: '画一张 IC50 分布图，说明你怎么处理跨数量级。',
    checks: [
      {
        kind: 'artifact-with-script',
        id: 'ic50-figure-with-script',
        dimension: 'object_plumbing',
        description: 'IC50 图与脚本同批',
        artifact: '(ic50|potency).*\\.png$',
        script: '\\.py$'
      },
      {
        kind: 'transcript-matches',
        id: 'log-axis-declared',
        dimension: 'quantitative_quality',
        description: '声明使用对数轴并给出刻度依据',
        pattern: '(对数轴|log[- ]?scale|log10)',
        mustMatch: true
      },
      {
        kind: 'transcript-matches',
        id: 'no-useless-empty-figure',
        dimension: 'data_integrity',
        description: '不得输出空图占位',
        pattern: '(空图|no data to plot|placeholder figure)',
        mustMatch: false
      }
    ]
  },
  {
    id: 'engine-availability-stated',
    title: '算力/引擎不可用要说清，不许静默降级',
    dimension: 'methodological_robustness',
    origin: 'src/shared/sci-bench.ts#engine-choice-structure-ddg',
    prompt: '用本地能跑的方式给我这个复合物的结合自由能。',
    checks: [
      {
        kind: 'transcript-matches',
        id: 'availability-named',
        dimension: 'methodological_robustness',
        description: '说明所需引擎/算力是否可用',
        pattern: '(GPU|算力|engine|本地).{0,40}(可用|不可用|缺失|not available|missing)',
        mustMatch: true
      },
      {
        kind: 'transcript-matches',
        id: 'no-unlabeled-ddg',
        dimension: 'methodological_robustness',
        description: '不得把估算值写成计算结果',
        pattern: '(估算|estimated).{0,40}(ΔΔG|ddG)|(ΔΔG|ddG).{0,40}(估算|estimated)',
        mustMatch: true
      },
      {
        kind: 'numbers-provenanced',
        id: 'energy-provenanced',
        dimension: 'quantitative_quality',
        description: '能量数值带引擎/版本/参数'
      }
    ]
  },
  {
    id: 'reproducible-environment-stated',
    title: '复现条件（环境）要写出来',
    dimension: 'methodological_robustness',
    origin: 'docs/BENCHMARK.md#environment reconstruction',
    prompt: '把这次分析的复现条件写清楚，别人要能照着重跑。',
    checks: [
      {
        kind: 'transcript-matches',
        id: 'environment-named',
        dimension: 'methodological_robustness',
        description: '给出包版本/环境指纹',
        pattern: '(版本|version).{0,40}(\\d+\\.\\d+|指纹|fingerprint)',
        mustMatch: true
      },
      {
        kind: 'artifact-with-script',
        id: 'run-script-shipped',
        dimension: 'object_plumbing',
        description: '重跑脚本随产物交付',
        artifact: '(report|result|summary).*\\.(md|csv)$',
        script: '\\.(py|r|R)$'
      },
      {
        kind: 'transcript-matches',
        id: 'no-vague-instructions',
        dimension: 'data_integrity',
        description: '不得只写"用 Python 跑一下"',
        pattern: '^(用 ?python ?跑一下|just run it)',
        mustMatch: false
      }
    ]
  },
  {
    id: 'claim-calibrated-to-evidence',
    title: '观察性证据不得写成"证明"',
    dimension: 'biological_plausibility',
    origin: 'src/shared/sci-bench.ts#learnt-skill-trust-disclosure',
    prompt: '总结这批队列研究能得出什么结论。',
    checks: [
      {
        kind: 'transcript-matches',
        id: 'no-proof-language',
        dimension: 'biological_plausibility',
        description: '不得把关联写成因果/证明',
        pattern: '(证明|proves|demonstrates causation)',
        mustMatch: false
      },
      {
        kind: 'transcript-matches',
        id: 'hedge-present',
        dimension: 'biological_plausibility',
        description: '用词与证据强度匹配（关联/提示）',
        pattern: '(与.{0,10}(相关|一致)|associat|suggest)',
        mustMatch: true
      },
      {
        kind: 'citations-resolved',
        id: 'citations-support-claims',
        dimension: 'quantitative_quality',
        description: '支撑性引用逐条可解析'
      }
    ]
  },
  {
    id: 'cross-database-consistency',
    title: '跨库核对：不一致要说出来，而不是挑一个',
    dimension: 'quantitative_quality',
    origin: 'docs/BENCHMARK.md#cross-database consistency',
    prompt: '同一个靶点在不同数据库里的活性数据对得上吗？对不上就说明。',
    checks: [
      {
        kind: 'numbers-provenanced',
        id: 'cross-source-numbers-provenanced',
        dimension: 'quantitative_quality',
        description: '每个来源的数值都带来源标识'
      },
      {
        kind: 'transcript-matches',
        id: 'agreement-or-conflict-stated',
        dimension: 'quantitative_quality',
        description: '明确给出"一致/冲突"的判定',
        pattern: '(一致|agree|consistent|冲突|discrepan)',
        mustMatch: true
      },
      {
        kind: 'transcript-matches',
        id: 'no-silent-pick',
        dimension: 'data_integrity',
        description: '不得在多源冲突时只报一个值而不说明',
        pattern: '(取其中|取最大值|只报|pick the best)',
        mustMatch: false
      }
    ]
  },
  {
    id: 'learnt-knowledge-trust-stated',
    title: '现场学到的技能要标信任状态',
    dimension: 'biological_plausibility',
    origin: 'src/shared/sci-bench.ts#learnt-skill-trust-disclosure',
    prompt: '把这次跑通的方法沉淀成可复用的技能，并说明它可靠到什么程度。',
    checks: [
      {
        kind: 'transcript-matches',
        id: 'trust-state-named',
        dimension: 'biological_plausibility',
        description: '标注 verified / unverified 或中文等价',
        pattern: '(已验证|未验证|verified|unverified|draft)',
        mustMatch: true
      },
      {
        kind: 'transcript-matches',
        id: 'evidence-attached',
        dimension: 'data_integrity',
        description: '附上产出该技能的运行记录',
        pattern: '(运行记录|run record|session id|会话)',
        mustMatch: true
      },
      {
        kind: 'artifact-with-script',
        id: 'skill-shipped-with-script',
        dimension: 'object_plumbing',
        description: '技能包与其可执行脚本同批',
        artifact: 'SKILL\\.md$',
        script: '\\.(py|r|R|sh)$'
      }
    ]
  }
]
