// A turn that dies early (provider gone after a context reset, egress reset) can leave its prompt interaction
// behind: every later send to that session is then refused with "An ACP prompt is already running for this
// session" and no turn ever runs — the session looks dead until the app restarts. Reproduced twice on one
// session; `acp.cancel` cleared it and the next send ran normally (reply 123 characters).
//
// The recovery is deliberately narrow: only a session that is *not* running from the store's point of view is
// recovered, so a genuine double-send keeps failing instead of cancelling the turn the user just started.

export const PROMPT_ALREADY_RUNNING_MESSAGE = 'An ACP prompt is already running for this session'

export const isPromptAlreadyRunningError = (error: unknown): boolean =>
  error instanceof Error
    ? error.message.includes(PROMPT_ALREADY_RUNNING_MESSAGE)
    : String(error).includes(PROMPT_ALREADY_RUNNING_MESSAGE)

export const sendPromptWithStaleTurnRecovery = async <T>(input: {
  send: () => Promise<T>
  cancel: () => Promise<unknown>
  /** True when the session has no live run, so a leftover interaction can be cleared without killing work. */
  isSessionIdle: () => boolean
  waitForCancel?: () => Promise<void>
}): Promise<T> => {
  try {
    return await input.send()
  } catch (error) {
    if (!isPromptAlreadyRunningError(error) || !input.isSessionIdle()) throw error
    // Clearing first is what makes the retry possible; the failure above proved nothing was running.
    await input.cancel().catch(() => undefined)
    await input.waitForCancel?.()
    return input.send()
  }
}
