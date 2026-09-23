// The window denies Chromium permission checks, the clipboard included, so a renderer cannot copy on its
// own. The main process can, without asking anyone.
const copyText = async (text: string): Promise<void> => {
  const bridge = window.api?.clipboard
  if (bridge) {
    await bridge.writeText({ text })
    return
  }
  // Surfaces without the app shell (tests, a plain browser) fall back to the web API when it exists.
  // Where neither exists there is nothing to copy with, and the caller is a surface that only ever ran
  // because a copy was optional.
  await navigator.clipboard?.writeText(text)
}

/**
 * Whether a copy can be attempted here, so a copy control can say so up front instead of failing silently.
 * Both sources count: the bridge the app provides, and the web API a bare renderer would have.
 */
const canCopyText = (): boolean => {
  if (typeof window === 'undefined') return false
  return Boolean(window.api?.clipboard ?? navigator.clipboard?.writeText)
}

export { canCopyText, copyText }
