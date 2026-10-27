// 只读「能力声明」端点（v2.19 第 3 步的一半）。
//
// 它声明的是**这个构建能做什么**，不是「兼容 A2A」。计划档 §4 写着：任何「兼容 A2A」的说法在实测之前
// 都不成立 —— 所以这里把那条边界写成机器可读字段（`interop.a2a: 'unverified'`），而不是靠注释约束人。
// 2026-10-27 起是 'verified'：一个独立客户端（另一进程、只用 HTTP + JSON-RPC、不 import 本仓代码）读了
// `/.well-known/agent-card.json` 并对打包版跑通 `message/send`（task `completed`、artifact `ok`、29.8 s）。
// 读数在 docs/evidence/2026-10-27-a2a-interop-probe.md；若哪天撤掉这个面，同一次改动里把它改回 'unverified'。
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
    /**
     * `verified` since 2026-10-27: an independent client (separate process, HTTP + JSON-RPC only, no import
     * from this tree) read `/.well-known/agent-card.json` and completed a `message/send` round-trip against
     * the packaged build — task `completed`, artifact text `ok`, 29.8 s. Readings:
     * docs/evidence/2026-10-27-a2a-interop-probe.md. If the surface is ever withdrawn, this goes back to
     * `unverified` in the same change that withdraws it.
     */
    a2a: 'unverified' | 'verified'
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
  // Flipped after the round-trip below actually ran against the packaged build, not before it.
  interop: { a2a: 'verified', acp: 'primary' }
})
