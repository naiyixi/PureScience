// Catalog of main-process sentences that the interface shows VERBATIM. Main composes these in
// English (it has no translator), and the sinks below print whatever it returned — a refusal is
// deliberately not reworded, because a reworded refusal hides which rule actually refused the click.
// Mapping the exact sentence back to a dictionary key keeps that property and still lets the reader
// see it in their own language; anything the renderer does not recognise passes through unchanged.
export const MAIN_MESSAGE_KEYS: Record<string, string> = {
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
