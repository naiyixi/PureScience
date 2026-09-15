// Which image sources would disclose the reader to another host, and which host that is.
//
// Kept apart from the renderer component because the renderer's fast-refresh boundary only allows a file
// to export components (react-refresh/only-export-components).
const REMOTE_SCHEMES = new Set(['http', 'https'])
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

/** True when rendering this source would disclose the viewer to another host. */
export const isRemoteMediaSource = (source: string | undefined): boolean => {
  const trimmed = source?.trim()
  if (!trimmed) return false
  const scheme = SCHEME.exec(trimmed)
  // A scheme-less source resolves against the app page, not against the network.
  if (!scheme) return false
  return REMOTE_SCHEMES.has(scheme[1].toLowerCase())
}

/** The host a reader is being asked to contact, or the raw source when it cannot be parsed. */
export const remoteMediaHost = (source: string): string => {
  try {
    return new URL(source.trim()).host
  } catch {
    return source.trim()
  }
}
