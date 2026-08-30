import type { FetchLike } from './github-import'

// Wraps a FetchLike so GitHub API / raw-content requests carry the user's stored token. The token
// raises the API rate limit and unlocks private-repo skill imports; it is only ever attached to
// github.com and api.github.com requests — other hosts (skill file redirects, codeload archives)
// are forwarded untouched so the credential never leaks to third parties.
export const withGitHubToken = (fetchLike: FetchLike, token: string): FetchLike => {
  const isGitHubHost = (url: string): boolean => {
    try {
      const parsed = new URL(url)
      return parsed.host === 'github.com' || parsed.host === 'api.github.com'
    } catch {
      return false
    }
  }

  return (url, init) => {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) }
    if (isGitHubHost(url)) {
      headers.authorization = `Bearer ${token}`
      headers.accept = 'application/vnd.github+json'
    }
    return fetchLike(url, { ...init, headers })
  }
}
