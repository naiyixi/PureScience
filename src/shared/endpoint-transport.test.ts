import { describe, expect, it } from 'vitest'

import {
  classifyEndpointTransport,
  ENDPOINT_INSECURE_REASON,
  reviewEndpointTransport
} from './endpoint-transport'

describe('endpoint transport', () => {
  it('accepts https, loopback http, and nothing else', () => {
    expect(classifyEndpointTransport('https://api.example.com/v1')).toBe('https')
    expect(classifyEndpointTransport('  https://api.example.com  ')).toBe('https')
    expect(classifyEndpointTransport('http://127.0.0.1:11434/v1')).toBe('loopback')
    expect(classifyEndpointTransport('http://localhost:8000')).toBe('loopback')
    expect(classifyEndpointTransport('http://[::1]:8000/v1')).toBe('loopback')
    expect(classifyEndpointTransport('http://gateway.internal/v1')).toBe('insecure')
    // A non-http protocol is never a provider endpoint the app should trust.
    expect(classifyEndpointTransport('ftp://gateway.internal')).toBe('insecure')
    // Unparseable is the URL parser's verdict to give (invalid base URL), not a transport verdict.
    expect(classifyEndpointTransport('gateway.internal')).toBeUndefined()
    expect(classifyEndpointTransport(undefined)).toBeUndefined()
    expect(classifyEndpointTransport('   ')).toBeUndefined()
  })

  it('refuses a plaintext remote endpoint by default, naming the reason', () => {
    const decision = reviewEndpointTransport({ url: 'http://gateway.internal/v1' })

    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe(ENDPOINT_INSECURE_REASON)
    expect(decision.message).toContain('http://gateway.internal/v1')
  })

  it('allows it only when that provider opted in explicitly', () => {
    expect(
      reviewEndpointTransport({ url: 'http://gateway.internal/v1', allowInsecureEndpoint: true })
    ).toEqual({ allowed: true, transport: 'insecure' })
    // Anything other than an explicit true is not consent — including a missing field.
    expect(reviewEndpointTransport({ url: 'http://gateway.internal/v1' }).allowed).toBe(false)
  })

  it('never refuses https or loopback, opted in or not', () => {
    for (const url of ['https://api.example.com', 'http://127.0.0.1:8080/v1']) {
      expect(reviewEndpointTransport({ url }).allowed).toBe(true)
      expect(reviewEndpointTransport({ url, allowInsecureEndpoint: false }).allowed).toBe(true)
    }
  })

  it('says nothing about an endpoint that was never configured', () => {
    expect(reviewEndpointTransport({ url: undefined })).toEqual({
      allowed: true,
      transport: undefined
    })
  })
})
