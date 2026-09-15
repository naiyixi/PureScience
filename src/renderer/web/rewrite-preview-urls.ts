// Rewrites preview URLs in an RPC result so the browser can fetch them, without touching anything else.
//
// This walks the whole result, and a walk that rebuilds every object destroys byte arrays: a Uint8Array
// is an object, so `Object.entries` turned one into a map of indices ({0: 37, 1: 80, …}) and PDF range
// reads arrived as that map instead of bytes — the preview then failed on every chunk with "response did
// not match the requested chunk". Dates have the same shape of problem: rebuilt key by key they become {}.

export const PREVIEW_URL_SCHEME = 'purescience-preview://'

export const rewritePreviewUrls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(rewritePreviewUrls)
  // Binary and dates are objects, but they are values, not containers to walk into.
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value
  if (value instanceof Date) return value
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) result[key] = rewritePreviewUrls(child)
    return result
  }
  if (typeof value === 'string' && value.startsWith(PREVIEW_URL_SCHEME)) {
    const url = new URL(value)
    return `/preview/${encodeURIComponent(url.hostname)}${url.pathname}`
  }
  return value
}
