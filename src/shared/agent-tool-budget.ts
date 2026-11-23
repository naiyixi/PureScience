// The wall-clock budget an agent client gives one MCP tool call, next to the largest deadline any
// notebook tool will accept. They are one contract in two places, so they live in one file.
//
// Why this matters: the notebook tools enforce their own deadlines and answer with a named message
// ("Shell command timed out after 120000ms and was killed."). That message only reaches the model if
// the client is still waiting for the answer. The client has its own budget and aborts the call
// itself with a reason of its own, so a client budget below the tool's deadline makes the tool's
// honest answer unreachable: the model gets a failure with no duration, no output and no hint that a
// longer budget can be asked for.
//
// Measured on a real machine (2026-11-09 … 2026-11-18): 40 tool calls failed with the client's own
// "The operation timed out." — 33 bash_execute, 7 notebook_execute, 1 inspect_packages, 2
// manage_packages — and none of them ever produced the tool's own message. Every one of those was
// work the tool would have reported on if it had been allowed to reach its own deadline.
//
// Invariant: NOTEBOOK_TOOL_MAX_TIMEOUT_MS < AGENT_MCP_TOOL_BUDGET_MS. The slack is what the client
// needs to receive the answer after the deadline fires (kill, output drain, RPC hop), so the named
// message wins the race by construction rather than by luck. A model asking for more than the
// maximum is refused by the schema, which names the bound, instead of being silently clamped.
export const NOTEBOOK_TOOL_DEFAULT_TIMEOUT_MS = 120_000
export const NOTEBOOK_TOOL_MAX_TIMEOUT_MS = 840_000
export const AGENT_MCP_TOOL_BUDGET_MS = 900_000
