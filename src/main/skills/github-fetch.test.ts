import { describe, expect, it, vi } from 'vitest'

import { withGitHubToken } from './github-fetch'
import type { FetchLike } from './github-import'

const noopFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  arrayBuffer: async () => new ArrayBuffer(0)
})

describe('withGitHubToken', () => {
  it('attaches the bearer token to github.com and api.github.com requests', async () => {
    const inner = vi.fn(noopFetch)
    const wrapped = withGitHubToken(inner, 'ghp_secret')

    await wrapped('https://api.github.com/repos/owner/repo/contents/SKILL.md')
    await wrapped('https://github.com/owner/repo/raw/main/SKILL.md')

    expect(inner).toHaveBeenCalledTimes(2)
    for (const [, init] of inner.mock.calls) {
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer ghp_secret',
        accept: 'application/vnd.github+json'
      })
    }
  })

  it('leaves non-GitHub hosts untouched so the token never leaks', async () => {
    const inner = vi.fn(noopFetch)
    const wrapped = withGitHubToken(inner, 'ghp_secret')

    await wrapped('https://codeload.github.com/owner/repo/tar.gz/main')
    await wrapped('https://raw.githubusercontent.com/owner/repo/main/SKILL.md')
    await wrapped('https://example.com/not-github')

    expect(inner).toHaveBeenCalledTimes(3)
    for (const [, init] of inner.mock.calls) {
      expect(init?.headers?.authorization).toBeUndefined()
    }
  })

  it('preserves caller-supplied headers on the wrapped request', async () => {
    const inner = vi.fn(noopFetch)
    const wrapped = withGitHubToken(inner, 'ghp_secret')

    await wrapped('https://api.github.com/search/repositories?q=skill', {
      headers: { 'user-agent': 'PureScience' }
    })

    expect(inner.mock.calls[0][1]?.headers).toMatchObject({
      'user-agent': 'PureScience',
      authorization: 'Bearer ghp_secret'
    })
  })
})
