// 结构内容摘要：**真 sha256**（拿 Node 的 WebCrypto 独立算一遍对值），以及「算不出来就不记」。

import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { sha256Text, type TextDigestSource } from './text-digest'

describe('sha256Text', () => {
  it('produces the real sha256 of the bytes a user is looking at', async () => {
    // Independently known value: sha256("hi") = 8f434346…
    await expect(sha256Text('hi', webcrypto.subtle)).resolves.toBe(
      'sha256:8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4'
    )
  })

  it('digests the text, not a re-serialized copy of it', async () => {
    const a = await sha256Text('CYS 145\nGLY 160\n', webcrypto.subtle)
    const b = await sha256Text('cys 145\ngly 160\n', webcrypto.subtle)
    expect(a).not.toBe(b)
    expect(a).toBeDefined()
  })

  it('records nothing rather than an invented digest when it cannot hash', async () => {
    // null means "this environment has no WebCrypto" — the app-visible consequence is that the
    // selection records no digest at all rather than a digest of something else.
    await expect(sha256Text('hi', null)).resolves.toBeUndefined()
    const failing: TextDigestSource = {
      digest: async () => {
        throw new Error('no crypto here')
      }
    }
    await expect(sha256Text('hi', failing)).resolves.toBeUndefined()
  })

  it('passes Uint8Array bytes to the digest implementation', async () => {
    const seen: Uint8Array[] = []
    const source: TextDigestSource = {
      digest: async (_algorithm, data) => {
        seen.push(data)
        return new Uint8Array(32).buffer
      }
    }
    const value = await sha256Text('CYS', source)
    expect(seen).toHaveLength(1)
    expect(Array.from(seen[0])).toEqual([67, 89, 83])
    expect(value).toBe(`sha256:${'00'.repeat(32)}`)
  })
})
