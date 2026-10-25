// 只读「能力声明」端点（v2.19 第 3 步的一半）。
//
// 它声明的是**这个构建能做什么**，不是「兼容 A2A」。计划档 §4 写着：任何「兼容 A2A」的说法在实测之前
// 都不成立 —— 所以这里把那条边界写成机器可读字段（`interop.a2a: 'unverified'`），而不是靠注释约束人。
// 等真做过互通测试（另一台机器上的实现能读这张卡并跑通 message/send），才允许把它改成 'verified'，
// 并且那时要附测试读数。
//
// 数据来源刻意少：版本/平台来自 bootstrap（index.ts 已备好），能力清单来自会话能力契约本身
// （CURRENT_PRIMARY_CAPABILITIES）—— 不新造一份「能力清单」，那会随时间与真实契约漂移。

import { CURRENT_PRIMARY_CAPABILITIES } from '../acp/session-capability-owner'

export const AGENT_CARD_SCHEMA = 'purescience/agent-card/1'

export type AgentCardPayload = {
  schema: typeof AGENT_CARD_SCHEMA
  name: string
  version: string
  platform: string
  /** App-owned capability names this build can attach to a session. */
  capabilities: string[]
  interop: {
    /** Explicitly unverified: no interop test has been run against another implementation. */
    a2a: 'unverified'
    /** The protocol this app itself drives sessions over. */
    acp: 'primary'
  }
}

export type AgentCardInput = {
  appName: string
  appVersion: string
  platform: string
  /** Injection seam: the route passes the real contract; tests pass their own list. */
  capabilityNames?: readonly string[]
}

export const buildAgentCardPayload = (input: AgentCardInput): AgentCardPayload => ({
  schema: AGENT_CARD_SCHEMA,
  name: input.appName,
  version: input.appVersion,
  platform: input.platform,
  capabilities: [...(input.capabilityNames ?? CURRENT_PRIMARY_CAPABILITIES)],
  interop: { a2a: 'unverified', acp: 'primary' }
})
