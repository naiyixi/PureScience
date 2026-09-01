// Shared identity + prompt contract for the agent-facing managed-endpoint MCP server. This is
// the "local model services" capability: an agent (or the user, via the settings panel)
// registers a LOCALLY HOSTED model server (a container, a llama.cpp/llama-server process, an
// Ollama instance, …) whose lifecycle the main process owns. Register once; afterwards the
// manager probes readiness before any caller is allowed through, runs the approved start
// script when the endpoint is stopped, and swaps state through a small machine
// (stopped → starting → live → failed). The start/stop scripts are opaque bash; the manager
// hands them HOST_PORT, SERVICE_DIR and the credential VALUE via process env so agent code
// never sees the secret, and local inference calls need no auth header.
//
// Design mirror of the reference product's managed_endpoints table + host.model_endpoints SDK,
// adapted to the PureScience main-process architecture (JSON-file repository + local RPC +
// capability owner, same spine as the routine capability).

export const ENDPOINT_MCP_SERVER_NAME = 'purescience-endpoints'

export const ENDPOINT_REGISTER_TOOL_NAME = 'endpoint_register'
export const ENDPOINT_UNREGISTER_TOOL_NAME = 'endpoint_unregister'
export const ENDPOINT_START_TOOL_NAME = 'endpoint_start'
export const ENDPOINT_STOP_TOOL_NAME = 'endpoint_stop'
export const ENDPOINT_STATUS_TOOL_NAME = 'endpoint_status'
export const ENDPOINT_LIST_TOOL_NAME = 'endpoint_list'
export const ENDPOINT_FREE_PORT_TOOL_NAME = 'endpoint_free_port'

export const ENDPOINT_REGISTER_TOOL_DESCRIPTION =
  'Registers a daemon-managed LOCAL model server. Provide a name ([a-z0-9-], 1-64 chars), the ' +
  'loopback URL (http://127.0.0.1:<port> — use endpoint_free_port to allocate), the runbook ' +
  'skill name documenting the model API, and opaque start/stop bash plus a readiness path ' +
  '(live=/health/ready style). start MUST be idempotent (inspect-and-start pattern) and ' +
  'receives HOST_PORT, SERVICE_DIR and the credential value in its env. Registration always ' +
  'shows an approval card with both scripts verbatim the first time (byte-identical ' +
  're-registration is silent); after approval the scripts are hash-pinned and re-runs skip the card.'

export const ENDPOINT_UNREGISTER_TOOL_DESCRIPTION =
  'Removes a managed endpoint by name. Stops it first if it is live. The name is the endpoint ' +
  'name from endpoint_register / endpoint_list.'

export const ENDPOINT_START_TOOL_DESCRIPTION =
  'Starts a registered managed endpoint now: runs the approved start script, probes the ' +
  'readiness path until the model answers (or a timeout fails the start), and reports the new ' +
  'state. Starting an already-live endpoint is a no-op success.'

export const ENDPOINT_STOP_TOOL_DESCRIPTION =
  'Stops a live managed endpoint: runs its stop script and moves it to stopped. Stopping an ' +
  'already-stopped endpoint is a no-op success.'

export const ENDPOINT_STATUS_TOOL_DESCRIPTION =
  'Returns the full state of one managed endpoint: state, last error, transcript tail, the ' +
  'registered URL and runbook skill, and the approved-script hash. Use it before starting to ' +
  'check readiness or after a failed start to read the error.'

export const ENDPOINT_LIST_TOOL_DESCRIPTION =
  'Lists every managed endpoint visible to this session with its state. Use it to discover ' +
  'what local model services are registered before choosing one to call.'

export const ENDPOINT_FREE_PORT_TOOL_DESCRIPTION =
  'Allocates a random host port from the managed range (20000-29999), skipping ports owned by ' +
  'other managed endpoints and ports currently bound on the machine. Use the result inside the ' +
  'url you pass to endpoint_register — the port lives in the URL and doubles as the endpoint ' +
  'mutex.'

// Managed-endpoint lifecycle states (mirrors the reference state machine).
export const ENDPOINT_STATE_STOPPED = 'stopped'
export const ENDPOINT_STATE_STARTING = 'starting'
export const ENDPOINT_STATE_LIVE = 'live'
export const ENDPOINT_STATE_FAILED = 'failed'

export type EndpointState =
  | typeof ENDPOINT_STATE_STOPPED
  | typeof ENDPOINT_STATE_STARTING
  | typeof ENDPOINT_STATE_LIVE
  | typeof ENDPOINT_STATE_FAILED

export const ENDPOINT_STATES: readonly EndpointState[] = [
  ENDPOINT_STATE_STOPPED,
  ENDPOINT_STATE_STARTING,
  ENDPOINT_STATE_LIVE,
  ENDPOINT_STATE_FAILED
]

// Managed port range for local model services.
export const ENDPOINT_PORT_RANGE_START = 20000
export const ENDPOINT_PORT_RANGE_END = 29999

// How long the manager waits for the readiness probe before failing a start (ms).
export const ENDPOINT_READY_TIMEOUT_MS = 120_000
// Probe interval while waiting for readiness (ms).
export const ENDPOINT_READY_POLL_MS = 1_000

// Persisted shape of one managed endpoint. Stored in a JSON file under the data root (same
// pattern as routines); the main process is the single writer.
export type ManagedEndpoint = {
  // Stable identity; [a-z0-9-], 1-64 chars. Doubles as the provider id callers use to address
  // the service (and the container name in the reference design).
  name: string
  // Local loopback URL (http://127.0.0.1:<port>). 'localhost' is rejected: rootless docker
  // resolves it to ::1 while the container publishes on IPv4.
  url: string
  // The port parsed from the URL; unique across managed endpoints.
  port: number
  // NAME of a saved credential whose VALUE is injected into the start script env (never
  // surfaced to agent code). Optional — local services without auth can omit it.
  credentialName?: string
  // Name of the runbook skill documenting the model's native API.
  skillName: string
  // Opaque bash run when the endpoint must come up. Must be idempotent. Receives HOST_PORT,
  // SERVICE_DIR and the credential value in its env.
  startScript: string
  // Opaque bash run when the endpoint must go down; must exit 0 only when fully stopped.
  stopScript: string
  // Readiness route probed on the endpoint URL (e.g. /health/ready or /v1/models).
  livePath: string
  // sha256 hex of the canonical script bytes (start + stop + live). Endpoints whose hash is in
  // the approval store re-start silently; any byte change forces a fresh approval card.
  approvedScriptHash: string
  registeredBy?: string
  state: EndpointState
  stateChangedAt: number | null
  lastError: string | null
  // Rolling transcript tail of lifecycle events (start attempts, probes, stops).
  transcript: string | null
  createdAt: number
  updatedAt: number
}

export type EndpointRegisterRequest = {
  name: string
  url: string
  skillName: string
  startScript: string
  stopScript: string
  livePath: string
  credentialName?: string
}

export type EndpointRegisterResult = {
  endpoint: ManagedEndpoint
  // True when this registration was approved by the user now (vs. silently accepted as a
  // byte-identical re-registration of an already-approved script set).
  newlyApproved: boolean
}

export type EndpointUnregisterResult = {
  removed: boolean
}

export type EndpointStartResult = {
  endpoint: ManagedEndpoint
}

export type EndpointStopResult = {
  endpoint: ManagedEndpoint
}

export type EndpointStatusResult = {
  endpoint: ManagedEndpoint | null
}

export type EndpointListResult = {
  endpoints: ManagedEndpoint[]
}

export type EndpointFreePortResult = {
  port: number
}

// Canonical bytes hashed for approval: start + stop + live (separated so a change in any one
// forces a new approval).
export function endpointScriptBytes(register: {
  startScript: string
  stopScript: string
  livePath: string
}): string {
  return [register.startScript, register.stopScript, register.livePath].join('\n---\n')
}

// Rendered into the session prompt when the endpoints MCP is available.
export const ENDPOINT_MCP_SYSTEM_PROMPT_APPEND = [
  '<purescience_endpoint_instructions>',
  'You can manage LOCALLY HOSTED model servers with the endpoint_* tools. A managed endpoint is ' +
    'a registered start/stop script pair plus a readiness route: the app owns its lifecycle, so ' +
    'calling the endpoint just works once registered — the manager starts it, probes readiness, ' +
    'and only then lets your call through.',
  'Use endpoint_free_port() to allocate a port, then endpoint_register(name, url, skillName, ' +
    'start, stop, live). The FIRST registration of a given script set shows a user approval ' +
    'card with the scripts verbatim; byte-identical re-registrations are silent.',
  'Before calling a model service, use endpoint_status(name) or endpoint_list() to check its ' +
    'state; if it is stopped, endpoint_start(name) brings it up (it may take a while — the ' +
    'manager polls readiness). Endpoints that fail to become ready enter state "failed" with a ' +
    'last_error; read it before retrying.',
  'Local endpoints need no auth header on inference calls — the credential value is injected ' +
    'into the start script env only. Never ask the user to paste an API key into a script.',
  '</purescience_endpoint_instructions>'
].join('\n')
