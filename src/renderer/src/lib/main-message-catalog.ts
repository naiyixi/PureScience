// Catalog of main-process sentences that the interface shows VERBATIM. Main composes these in
// English (it has no translator), and the sinks below print whatever it returned — a refusal is
// deliberately not reworded, because a reworded refusal hides which rule actually refused the click.
// Mapping the exact sentence back to a dictionary key keeps that property and still lets the reader
// see it in their own language; anything the renderer does not recognise passes through unchanged.
export const MAIN_MESSAGE_KEYS: Record<string, string> = {
  'Could not reserve an OpenCode usage API port.': 'mainMessage.opencodePortReserveFailed',
  'PureScience Codex ACP adapter not found. Install Codex in settings.':
    'mainMessage.codexAcpAdapterMissing',
  'No SKILL.md found at the linked location.': 'mainMessage.githubNoSkillMd',
  'GitHub returned an invalid repository search response.':
    'mainMessage.githubInvalidSearchResponse',
  'GitHub did not return a commit SHA for that ref.': 'mainMessage.githubNoCommitSha',
  'Connector ID must use only lowercase letters, numbers, and hyphens':
    'mainMessage.connectorIdShape',
  'OAuth is only supported for remote custom connectors': 'mainMessage.connectorOauthRemoteOnly',
  'OAuth and static headers cannot be configured together':
    'mainMessage.connectorOauthHeaderConflict',
  'Invalid custom connector configuration': 'mainMessage.connectorInvalidConfig',
  'Expected a JSON object of MCP servers': 'mainMessage.connectorMcpServersNotObject',
  'Expected `mcpServers` to be a JSON object of servers':
    'mainMessage.connectorMcpServersKeyNotObject',
  'Carries an Anthropic OAuth token (setup-token) in app-owned storage, which only Claude Code can carry. Switch to Claude Code or pick another provider.':
    'mainMessage.providerIncompatibleClaudeIsolated',
  'Browser sign-in is unavailable: the Claude executable was not found.':
    'mainMessage.claudeExecutableMissing',
  'Secure credential storage is unavailable. Unlock the system keychain and retry.':
    'mainMessage.claudeKeychainLocked',
  'Another sign-in is already in progress.': 'mainMessage.claudeSignInInProgress',
  'Stored Claude token could not be read.': 'mainMessage.claudeStoredTokenUnreadable',
  'Browser sign-in failed.': 'mainMessage.claudeBrowserSignInFailed',
  'Paste the token printed by `claude setup-token`.': 'mainMessage.claudePasteTokenPrompt',
  'Could not save the Claude token.': 'mainMessage.claudeTokenSaveFailed',
  'Saved token could not be re-read. Retry the paste.': 'mainMessage.claudeTokenRereadFailed',
  'Saved token did not roundtrip cleanly. Retry the paste.':
    'mainMessage.claudeTokenRoundtripFailed',
  'Stored token could not be re-read.': 'mainMessage.claudeStoredTokenRereadFailed',
  'Could not clear the stored Claude token.': 'mainMessage.claudeTokenClearFailed',
  'The selected Codex profile does not contain importable authentication.':
    'mainMessage.codexProfileNotImportable',
  'The installed codex-acp does not advertise ChatGPT authentication.':
    'mainMessage.codexAcpNoChatGptAuth',
  'Codex status check timed out.': 'mainMessage.codexStatusTimedOut',
  'A Codex sign-in is already in progress.': 'mainMessage.codexSignInInProgress',
  'Codex sign-out timed out.': 'mainMessage.codexSignOutTimedOut',
  "This location's path is too long for Windows. Choose a folder closer to the drive root so your files stay within Windows' 260-character path limit.":
    'mainMessage.pathTooLongForWindows',
  "That interpreter can't be used as a notebook runtime (not a runnable Python 3).":
    'mainMessage.notebookRuntimeUnusable',
  'Browser sign-in timed out. If your browser did not open, use "Use setup token" instead.':
    'mainMessage.signInTimedOut',
  'Sign-in cancelled.': 'mainMessage.signInCancelled',
  'Browser sign-in did not return a token. If your browser did not open, use "Use setup token" instead.':
    'mainMessage.signInNoToken'
}

// Two sentences are composed around a value (the runtime's own detail line, the runtime language), so
// they cannot be matched verbatim. Each entry names the one placeholder it captures — a loose pattern
// would rewrite text the reader needed as-is, which is the failure mode this catalog exists to avoid.
const MAIN_MESSAGE_TEMPLATES: ReadonlyArray<{
  pattern: RegExp
  key: string
  fill: readonly string[]
}> = [
  {
    pattern: /^That interpreter can't be used as a notebook runtime: (.+)$/,
    key: 'mainMessage.notebookRuntimeUnusableDetail',
    fill: ['{detail}']
  },
  {
    pattern:
      /^Not compatible with (.+?): it needs (.+?), but this provider speaks (.+?)\. Change the API format or switch the agent framework\.$/,
    key: 'mainMessage.providerIncompatibleGeneric',
    fill: ['{framework}', '{needs}', '{speaks}']
  },
  {
    pattern: /^Installing packages into your own (.+?) environment is not authorized\./,
    key: 'mainMessage.packageInstallNotAuthorized',
    fill: ['{language}']
  }
]

export const localizeMainMessage = (translator: unknown, message: string): string => {
  const translate = translator as (key: string) => string
  const exact = MAIN_MESSAGE_KEYS[message]
  if (exact) return translate(exact)

  for (const template of MAIN_MESSAGE_TEMPLATES) {
    const match = template.pattern.exec(message)
    if (!match) continue
    let text = translate(template.key)
    template.fill.forEach((slot, index) => {
      text = text.replace(slot, match[index + 1] ?? '')
    })
    return text
  }

  return message
}

// The transport wraps whatever main said before the interface sees it: Electron prefixes every rejected
// `invoke` with `Error invoking remote method '<channel>': <ErrorName>: <cause>`, and the local Web RPC
// client strips it down to `.message` (http-server.ts sends `error.message` verbatim). Both shapes are
// unwrapped in ONE place so a sink can match the sentence main actually composed — a sentence that is
// never recognised because of a wrapper is a sentence the reader gets in English.
const IPC_ENVELOPE = /^Error invoking remote method '[^']*':\s*/i
const ERROR_NAME_PREFIX = /^(?:Error|[A-Za-z]+Error):\s*/

export const unwrapIpcEnvelope = (message: string): string =>
  message.replace(IPC_ENVELOPE, '').replace(ERROR_NAME_PREFIX, '').trim()
