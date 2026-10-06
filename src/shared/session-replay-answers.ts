import type { SessionReplayStep } from './session-replay-steps'

// IC52 stage 2: asking about one step, answered from the step's own record only.
//
// The routing is local on purpose: a question is matched to a topic by keywords, every answer names the
// recorded field it came from, and a topic the record does not carry is answered as `recorded: false`
// rather than guessed at. Nothing here calls a model, so nothing here can invent a fact — a question the
// record cannot answer comes back with `topic: null`, which the view says in words.
export type StepAnswerTopic = 'call' | 'files' | 'outcome' | 'output' | 'prompt' | 'artifacts'

/** The recorded field a fact was read from — the citation a reader can go and check. */
export type StepAnswerSource =
  | 'providerToolName'
  | 'title'
  | 'status'
  | 'terminalExitCode'
  | 'terminalOutput'
  | 'toolLocations'
  | 'promptMessageId'
  | 'artifactIds'

export type StepAnswerFact = {
  source: StepAnswerSource
  /** The value as the session recorded it; absent when the record does not carry it. */
  value?: string
  /** False when the field the answer would need was never recorded for this step. */
  recorded: boolean
}

export type StepAnswer = {
  /** Which topic the question routed to; `null` when nothing in this record answers it. */
  topic: StepAnswerTopic | null
  facts: StepAnswerFact[]
}

const KEYWORDS: Record<StepAnswerTopic, readonly string[]> = {
  call: ['call', 'tool', 'called', 'name', 'invoke', '调用', '工具', '名字'],
  files: ['file', 'files', 'touch', 'touched', 'write', 'wrote', 'path', '文件', '写', '路径'],
  outcome: [
    'end',
    'exit',
    'status',
    'fail',
    'failed',
    'succeed',
    'done',
    '结束',
    '退出',
    '状态',
    '成功',
    '失败'
  ],
  output: ['output', 'print', 'printed', 'stdout', 'log', '输出', '打印', '日志'],
  prompt: ['prompt', 'turn', 'attached', 'belong', '提示', '哪一轮', '属于'],
  artifacts: ['artifact', 'artefact', 'reference', '产物', '引用']
}

const topicOrder: readonly StepAnswerTopic[] = [
  'call',
  'files',
  'outcome',
  'output',
  'prompt',
  'artifacts'
]

const fact = (source: StepAnswerSource, value?: string): StepAnswerFact =>
  value === undefined || value === ''
    ? { source, recorded: false }
    : { source, value, recorded: true }

const factsFor = (topic: StepAnswerTopic, step: SessionReplayStep): StepAnswerFact[] => {
  switch (topic) {
    case 'call':
      return [
        fact('providerToolName', step.toolName),
        // The title is what the session has even when it recorded no provider tool name.
        fact('title', step.title)
      ]
    case 'files':
      return [fact('toolLocations', step.locations ? String(step.locations.length) : undefined)]
    case 'outcome':
      return [
        fact('status', step.status),
        fact(
          'terminalExitCode',
          step.terminalExitCode === undefined || step.terminalExitCode === null
            ? undefined
            : String(step.terminalExitCode)
        )
      ]
    case 'output':
      return [fact('terminalOutput', step.terminalOutput)]
    case 'prompt':
      return [fact('promptMessageId', step.promptMessageId)]
    case 'artifacts':
      return [
        fact(
          'artifactIds',
          step.artifactIds.length > 0 ? String(step.artifactIds.length) : undefined
        )
      ]
  }
}

/**
 * Routes a question to the topic whose keywords it contains, earliest topic in `topicOrder` winning ties,
 * and answers it from the step's own record. A question with no matching keyword is not answered —
 * `topic: null` — because pretending to understand it would be the first step towards inventing a fact.
 */
export const answerStepQuestion = (step: SessionReplayStep, question: string): StepAnswer => {
  const normalised = question.trim().toLowerCase()
  if (normalised === '') return { topic: null, facts: [] }

  // English keywords match whole words: a substring test would route "is this statistically
  // significant?" to `call` ("stati·call·y") and answer a question nobody asked. Chinese keywords match
  // as substrings because written Chinese has no spaces between words.
  const words = new Set(normalised.split(/[^a-z0-9\u4e00-\u9fff]+/u).filter(Boolean))
  const matches = (keyword: string): boolean =>
    /[\u4e00-\u9fff]/u.test(keyword) ? normalised.includes(keyword) : words.has(keyword)

  const matched = topicOrder.find((topic) => KEYWORDS[topic].some(matches))
  if (!matched) return { topic: null, facts: [] }

  return { topic: matched, facts: factsFor(matched, step) }
}
