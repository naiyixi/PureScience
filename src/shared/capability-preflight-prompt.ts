// What the agent should be told BEFORE it acts, rather than asked after the fact.
//
// Measured on 2026-10-22: the `capability_preflight` tool was mounted and callable, and a real run used
// it zero times (2 tool calls total, neither of them a skill tool). A preflight that only answers when
// asked therefore changes nothing for a model that does not ask. This block is the alternative: the
// gaps are rendered into the turn's own instructions, so "you cannot run X yet" arrives without a call.
//
// Rules:
// - Only unsatisfied requirements are rendered. A capability whose inputs are already present adds noise
//   and dilutes the one line that matters.
// - Every line names a concrete next step (which capability establishes the fact) or says plainly that
//   nothing in this install does.
// - Nothing is invented: facts come from the session, producers from the declared contracts.

import type { CapabilityContract, StateFact } from './capability-contract'
import type { PreflightResult } from './capability-preflight'

export type CapabilityGap = {
  capability: string
  missing: PreflightResult['missing']
}

export type RenderInput = {
  /** Capabilities the session is about to use, in the order they were selected. */
  selected: string[]
  contracts: Pick<CapabilityContract, 'id' | 'requires' | 'produces'>[]
  /** Facts the session already holds. */
  facts: StateFact[]
  /** Hard ceiling so a large install cannot flood the prompt. */
  maxLines?: number
}

const DEFAULT_MAX_LINES = 12

const factLabel = (fact: StateFact): string => fact.replace(/^[a-z]+:/u, '').replace(/_/gu, ' ')

/**
 * Renders the "you cannot run this yet" block, or null when there is nothing to say.
 * Absence of a block is a meaningful answer too: it means every selected capability is ready.
 */
export const renderCapabilityGaps = (input: RenderInput): string | null => {
  const held = new Set(input.facts)
  const byId = new Map(input.contracts.map((contract) => [contract.id, contract]))
  const limit = input.maxLines ?? DEFAULT_MAX_LINES

  const lines: string[] = []
  let truncated = 0

  for (const capabilityId of input.selected) {
    const contract = byId.get(capabilityId)
    if (!contract) continue
    const missing = contract.requires.filter((fact) => !held.has(fact))
    if (missing.length === 0) continue

    for (const fact of missing) {
      // Which declared capability would produce this fact? Name them; if none does, say so.
      const producers = input.contracts
        .filter((candidate) => candidate.produces.includes(fact))
        .map((candidate) => candidate.id)
      if (lines.length >= limit) {
        truncated += 1
        continue
      }
      const tail =
        producers.length > 0
          ? `先运行 ${producers.slice(0, 3).join(' 或 ')} 生成它`
          : '当前安装里没有能力声明会生成它，需要用户提供或说明'
      lines.push(`- ${capabilityId} 需要 ${factLabel(fact)}（${fact}），本会话没有；${tail}。`)
    }
  }

  if (lines.length === 0) return null

  const header = [
    '<purescience_capability_gaps>',
    '以下能力在本会话当前状态下缺少输入。这不阻止你执行，但先补齐再跑会少走弯路：'
  ]
  const footer = [
    ...(truncated > 0
      ? [`（另有 ${truncated} 条未列出，可用 capability_preflight 逐个查询。）`]
      : []),
    '</purescience_capability_gaps>'
  ]
  return [...header, ...lines, ...footer].join('\n')
}
