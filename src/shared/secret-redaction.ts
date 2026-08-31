// Sensitive-credential redaction for persisted job output. Remote compute jobs may echo
// environment secrets (API keys, bearer tokens, cloud keys) into stdout/stderr; the tails we
// persist must never retain a working secret in plaintext. Applied at the persistence boundary
// (job dispatcher and poller) before tails reach the SQLite job table.

const SECRET_PATTERNS: readonly RegExp[] = [
  // Anthropic / OpenAI-style keys: sk-... (also sk-ant-, sk-proj-)
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // AWS access key
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub fine-grained / PAT tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Bearer / Basic authorization headers
  /\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
  // Query-style assignments: token=, api_key=, apikey=, secret=, password=, access_token=.
  // A word-char/underscore/hyphen prefix is allowed so compound names (MODAL_TOKEN_SECRET,
  // GH_TOKEN, NVIDIA_API_KEY) redact too; the whole key=value span is replaced.
  /\b[A-Za-z0-9_-]*(?:token|api[_-]?key|secret|password|passwd|access[_-]?token|client[_-]?secret)\b\s*=\s*[^\s&"'`;]{6,}/gi
]

const REDACTED = '[REDACTED]'

// Replaces every recognized secret-shaped substring with a fixed marker. Safe for long tails
// (single pass over each pattern); the marker keeps line structure intact so logs stay readable.
export const redactSecrets = (text: string): string => {
  if (!text) return text
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED)
  }
  return result
}
