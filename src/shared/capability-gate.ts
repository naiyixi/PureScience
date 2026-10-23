// The hard gate: refuse a turn the user explicitly aimed at a capability that cannot run yet.
//
// Everything before this point tried to TELL the model. Measured on 2026-10-22: the tool was mounted and
// called zero times; the gap notice reached the prompt every turn (12 lines) and the agent still opened
// no skill file in 10 runs. Advice only works on a reader that reads. So this path is app-side: the turn
// does not start, and the reason is the contract's own words.
//
// Bounded on purpose:
//   • only capabilities the user explicitly picked (forcedSkillIds) are considered — never a global scan;
//   • only capabilities whose contract declares `failure_policy.missing_state` are blocked, so a skill
//     author opts in and nothing else can be caught by surprise;
//   • a capability with no usable contract is never blocked (we have nothing to check it against).

import type { CapabilityContract, StateFact } from './capability-contract'

export type CapabilityGateRefusal = {
  capability: string
  missing: { fact: StateFact; producers: string[] }[]
  /** Ready to surface verbatim: names the capability, the missing fact, who produces it, and the policy. */
  message: string
}

const factLabel = (fact: StateFact): string => fact.replace(/^[a-z]+:/u, '').replace(/_/gu, ' ')

export const evaluateCapabilityGate = (input: {
  /** Capabilities the turn was explicitly aimed at. Empty means "no gate applies". */
  referenced: readonly string[]
  contracts: readonly Pick<CapabilityContract, 'id' | 'requires' | 'produces' | 'failurePolicy'>[]
  facts: readonly StateFact[]
}): CapabilityGateRefusal | null => {
  const held = new Set(input.facts)
  const byId = new Map(input.contracts.map((contract) => [contract.id, contract]))

  for (const id of input.referenced) {
    const contract = byId.get(id)
    if (!contract) continue
    const policy = contract.failurePolicy?.missing_state
    // No declared policy means the author has not asked to be gated; respect that.
    if (typeof policy !== 'string' || policy.trim().length === 0) continue

    const missing = contract.requires
      .filter((fact) => !held.has(fact))
      .map((fact) => ({
        fact,
        producers: input.contracts
          .filter((candidate) => candidate.produces.includes(fact) && candidate.id !== id)
          .map((candidate) => candidate.id)
      }))
    if (missing.length === 0) continue

    const detail = missing
      .map((entry) => {
        const head = `${entry.fact}（${factLabel(entry.fact)}）`
        return entry.producers.length > 0
          ? `${head}，可先运行 ${entry.producers.slice(0, 3).join(' 或 ')} 生成`
          : `${head}，当前安装里没有能力声明会生成它，需要用户提供`
      })
      .join('；')

    return {
      capability: id,
      missing,
      message: `无法开始「${id}」：缺少 ${detail}。契约声明的处理方式：${policy.trim()}`
    }
  }

  return null
}
