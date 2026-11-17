// The two timeout refusals a reader actually has to act on.
//
// Field evidence: 113 notebook/bash timeouts in seventeen days. The message said only that the budget ran
// out, so the next attempt was the same cell again. These name the mechanism (a soft interrupt was already
// sent; the kernel was dropped) and the three things that can change the outcome.
//
// Kept as pure functions so the wording is pinned by tests without spawning a kernel.

export const notebookExecutionTimeoutMessage = (timeoutMs: number): string =>
  `Notebook execution timed out after ${timeoutMs}ms. A soft interrupt was sent first and the cell still ` +
  'did not return, so this kernel was dropped. Split the cell, raise the per-run timeout, or look for a ' +
  'loop that never ends.'

export const notebookStartupGraceMessage = (): string =>
  'Notebook kernel never began executing: its startup grace expired, so the kernel was dropped. Retry ' +
  'once; if it repeats, the environment interpreter is failing to start.'
