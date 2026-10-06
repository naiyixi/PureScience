import { describe, expect, it } from 'vitest'

import { answerStepQuestion } from './session-replay-answers'
import type { SessionReplayStep } from './session-replay-steps'

const step = (over: Partial<SessionReplayStep> = {}): SessionReplayStep => ({
  id: 'tool:a1',
  kind: 'tool',
  messageId: 'a1',
  promptMessageId: 'm1',
  title: 'Run python',
  status: 'completed',
  toolName: 'run_python',
  createdAt: 1,
  artifactIds: [],
  ...over
})

describe('answerStepQuestion', () => {
  it('routes a question about files to the recorded locations, naming the field it read', () => {
    const answer = answerStepQuestion(
      step({ locations: [{ path: '/a' }, { path: '/b' }] as never }),
      'Which files did it touch?'
    )

    expect(answer.topic).toBe('files')
    expect(answer.facts).toEqual([{ source: 'toolLocations', value: '2', recorded: true }])
  })

  it('routes the same question asked in Chinese', () => {
    expect(answerStepQuestion(step(), '它写了哪些文件？').topic).toBe('files')
  })

  it('says a field was not recorded rather than answering around it', () => {
    const answer = answerStepQuestion(step(), 'What did it print to stdout?')

    expect(answer.topic).toBe('output')
    // No terminal output was recorded for this step, so the answer says exactly that.
    expect(answer.facts).toEqual([{ source: 'terminalOutput', recorded: false }])
  })

  it('prefers the provider tool name and falls back to the title, both cited', () => {
    expect(answerStepQuestion(step(), 'what tool was called?').facts).toEqual([
      { source: 'providerToolName', value: 'run_python', recorded: true },
      { source: 'title', value: 'Run python', recorded: true }
    ])

    expect(
      answerStepQuestion(step({ toolName: undefined }), 'what tool was called?').facts[0]
    ).toEqual({
      source: 'providerToolName',
      recorded: false
    })
  })

  it('answers null for a question its record cannot answer', () => {
    const answer = answerStepQuestion(step(), 'Is this result statistically significant?')

    // Nothing local matches, and inventing an answer is exactly what this unit refuses to do.
    expect(answer.topic).toBeNull()
    expect(answer.facts).toEqual([])
  })

  it('answers null for an empty question', () => {
    expect(answerStepQuestion(step(), '   ').topic).toBeNull()
  })
})
