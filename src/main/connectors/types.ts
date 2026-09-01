export type ConnectorCredentials = { ncbiEmail?: string; ncbiApiKey?: string }

export type ToolContext = {
  fetchJson(url: string): Promise<unknown>
  fetchText(url: string): Promise<string>
  // GET JSON plus the response headers — for APIs that report totals/pagination in headers rather than
  // the body (e.g. PRIDE Archive's `total_records`), which fetchJson alone would drop.
  fetchJsonWithHeaders(url: string): Promise<{ body: unknown; headers: Headers }>
  // POST a JSON body and parse the JSON response — for GraphQL / POST-only APIs (e.g. gnomAD).
  postJson(url: string, body: unknown): Promise<unknown>
  // Optional sub-agent executor injected when this tool call happens inside a live agent session
  // (ACP runtime). Lets a tool delegate independent parallel sub-tasks to fresh agent sessions —
  // the building block for multi-agent orchestration (parallel literature reviews, decompose-run).
  // Absent in plain HTTP/web contexts (tools that require it report a clear error).
  runSubAgent?: (request: {
    prompt: string
    // Optional explicit model override for the sub-agent session.
    model?: string
    // Optional structured contract the sub-agent should satisfy; surfaced to the sub-agent prompt.
    completionContract?: string[]
    // Wait budget in ms (default 300_000). A sub-agent that exceeds it is aborted and reported.
    timeoutMs?: number
  }) => Promise<{ output: string; error?: string }>
  credentials: ConnectorCredentials
}

// One connector tool = a request-mapper (url) + response-parser (parse), or a run() escape hatch.
export type ToolDescriptor = {
  id: string
  connector: string
  description: string
  input: Record<string, unknown> // JSON Schema for the tool args (also used by docs)
  // Human-readable shape of the returned value, shown as a "Returns:" block in the skill doc so an
  // agent knows the result structure without running a probe cell. Free-form (prose or a shape sketch).
  returns?: string
  // A concrete, copy-runnable `await host.mcp(...)` call for the skill doc (rendered in the repl_execute
  // JS example block), using realistic argument values (e.g. real PMIDs) instead of the schema-derived
  // placeholders. Just the call — general guidance (result reuse, shape lives in Returns) belongs in the
  // shared conventions template, not repeated here. When omitted, the doc renders a bare call built from `input`.
  example?: string
  required?: string[]
  format?: 'json' | 'text'
  // License gate: when true, this tool fails closed unless the user declared non-commercial use.
  // Mark sources whose terms restrict commercial use (e.g. CADD: free for non-commercial only).
  noncommercialOnly?: boolean
  url?: (args: Record<string, unknown>) => string
  parse?: (raw: unknown, args: Record<string, unknown>) => unknown
  run?: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>
}
