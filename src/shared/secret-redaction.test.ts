import { describe, expect, it } from 'vitest'

import { redactSecrets } from './secret-redaction'

describe('redactSecrets', () => {
  it('redacts Anthropic/OpenAI-style sk- keys', () => {
    expect(redactSecrets('key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890 more')).toBe(
      'key=[REDACTED] more'
    )
  })

  it('redacts AWS access keys', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]')
  })

  it('redacts GitHub tokens', () => {
    expect(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH')).toBe('[REDACTED]')
  })

  it('redacts bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.xyz')).toBe(
      'Authorization: [REDACTED]'
    )
  })

  it('redacts key=value credential assignments (whole span, compound names included)', () => {
    expect(redactSecrets('export MODAL_TOKEN_SECRET=abc123def456ghi789; run')).toBe(
      'export [REDACTED]; run'
    )
  })

  it('redacts api_key query-style assignments', () => {
    expect(redactSecrets('curl -H "api_key=deadbeefcafe1234" url')).toBe('curl -H "[REDACTED]" url')
  })

  it('leaves ordinary output untouched', () => {
    const clean = 'loading data ... done, 42 rows, p-value=0.03'
    expect(redactSecrets(clean)).toBe(clean)
  })

  it('handles empty and non-string-adjacent input', () => {
    expect(redactSecrets('')).toBe('')
  })

  it('keeps line structure intact while redacting', () => {
    const out = redactSecrets('line1\nBearer abcdefghijklmnopqrstuvwxyz123456\nline3')
    expect(out).toBe('line1\n[REDACTED]\nline3')
  })
})
