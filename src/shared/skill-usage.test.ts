// Skill reuse ledger: attachments found in the activity stream, and the honest per-skill summary.
import { describe, expect, it } from 'vitest'

import { skillUsagesFromActivities, summarizeSkillUsage } from './skill-usage'

// The shape the app emits: title 'Loaded skill: <name>', call id 'purescience-skill-<turn>-<index>'.
const loaded = (
  name: string,
  turn: number,
  index: number,
  status = 'completed'
): { id: string; providerToolName: string; title: string; status: string } => ({
  id: `purescience-skill-${turn}-${index}`,
  providerToolName: 'skill',
  title: `Loaded skill: ${name}`,
  status
})

describe('skill reuse ledger', () => {
  it('finds the skills attached to a session, with the turn they belong to', () => {
    const usages = skillUsagesFromActivities([
      { id: 'call_1', providerToolName: 'Bash', title: 'Run tests', status: 'completed' },
      loaded('citation-integrity', 1, 0),
      loaded('evidence-grading', 1, 1),
      loaded('citation-integrity', 3, 0, 'failed')
    ])

    expect(usages).toEqual([
      {
        skillName: 'citation-integrity',
        turn: 1,
        status: 'completed',
        activityId: 'purescience-skill-1-0'
      },
      {
        skillName: 'evidence-grading',
        turn: 1,
        status: 'completed',
        activityId: 'purescience-skill-1-1'
      },
      {
        skillName: 'citation-integrity',
        turn: 3,
        status: 'failed',
        activityId: 'purescience-skill-3-0'
      }
    ])
  })

  it('ignores provider tool calls and anything unnamed', () => {
    const usages = skillUsagesFromActivities([
      // The provider has its own Skill tool; only the app's emission names what was loaded.
      { id: 'call_skill', providerToolName: 'Skill', title: 'Skill', status: 'completed' },
      {
        id: 'purescience-skill-2-0',
        providerToolName: 'skill',
        title: 'Loaded skill: ',
        status: 'completed'
      },
      {
        id: 'purescience-skill-bad-0',
        providerToolName: 'skill',
        title: 'Loaded skill: report',
        status: 'completed'
      }
    ])

    expect(usages).toEqual([
      {
        skillName: 'report',
        status: 'completed',
        activityId: 'purescience-skill-bad-0'
      }
    ])
    // The turn is optional: a call id without one still yields the usage, just without a position.
    expect(usages[0]?.turn).toBeUndefined()
  })

  it('counts uses and failures per skill, most used first', () => {
    const summary = summarizeSkillUsage(
      skillUsagesFromActivities([
        loaded('citation-integrity', 1, 0),
        loaded('citation-integrity', 2, 0, 'failed'),
        loaded('evidence-grading', 1, 1),
        loaded('citation-integrity', 5, 0)
      ])
    )

    expect(summary).toEqual([
      { skillName: 'citation-integrity', uses: 3, failures: 1, lastTurn: 5 },
      { skillName: 'evidence-grading', uses: 1, failures: 0, lastTurn: 1 }
    ])
  })

  it('reports nothing for a session that attached no skill, rather than inventing a ranking', () => {
    expect(summarizeSkillUsage(skillUsagesFromActivities([]))).toEqual([])
    expect(
      summarizeSkillUsage(
        skillUsagesFromActivities([{ id: 'call_1', status: 'completed', title: 'Run tests' }])
      )
    ).toEqual([])
  })
})
