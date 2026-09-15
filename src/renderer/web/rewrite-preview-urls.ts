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
    // The id can arrive in the host (`scheme://id/name`) or at the start of the path
    // (`scheme:////id/content`), the latter when a URL is rebuilt from an already slash-prefixed path and
    // loses its host. The route takes the first path segment as the resource id and answers 404 for an
    // empty one, so normalize both shapes to `/preview/<id><suffix>`.
    const segments = `${url.hostname}${url.pathname}`
      .split('/')
      .filter((segment) => segment.length > 0)
    const [id, ...rest] = segments
    if (!id) return value
    return `/preview/${encodeURIComponent(decodeURIComponent(id))}${
      rest.length > 0 ? `/${rest.join('/')}` : ''
    }`
  }
  return value
}
