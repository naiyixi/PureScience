// Landing policy for a palette message hit, kept out of the component file: the refresh boundary
// requires a module that exports only components, and this policy is worth testing on its own.

// A freshly opened session renders its transcript a frame or two later, so the scroll is repeated a
// bounded number of times and then abandoned — never retried forever, never reported as if it worked.
export const MESSAGE_FOCUS_ATTEMPTS = 6
export const MESSAGE_FOCUS_RETRY_MS = 250

export const shouldRetryMessageFocus = (attempt: number): boolean =>
  attempt < MESSAGE_FOCUS_ATTEMPTS
