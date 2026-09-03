import { afterEach, describe, expect, it } from 'vitest'

import { sanitizeProxySettings } from './repository'
import { sanitizeScenarioModels } from './repository'
import {
  applyProxySettings,
  manualProxyEnvironment,
  proxySettingsForTest,
  resetProxyRuntimeForTest
} from '../net/proxy-runtime'
import { loopbackProxyBypassEnvironment } from './system-proxy'

afterEach(() => {
  resetProxyRuntimeForTest()
})

describe('sanitizeProxySettings', () => {
  it('accepts the follow-system default', () => {
    expect(sanitizeProxySettings({ mode: 'system' })).toEqual({ mode: 'system' })
  })

  it('accepts a valid manual HTTP proxy and trims/derives fields', () => {
    expect(
      sanitizeProxySettings({
        mode: 'manual',
        manual: { type: 'http', host: ' 127.0.0.1 ', port: 7890, noProxy: [' localhost', ''] }
      })
    ).toEqual({
      mode: 'manual',
      manual: { type: 'http', host: '127.0.0.1', port: 7890, noProxy: ['localhost'] }
    })
  })

  it.each(['gopher', 'socks4', 'HTTP'])('rejects an unknown proxy type (%s)', (type) => {
    expect(
      sanitizeProxySettings({ mode: 'manual', manual: { type, host: 'h', port: 1 } })
    ).toBeUndefined()
  })

  it('rejects a missing host', () => {
    expect(
      sanitizeProxySettings({ mode: 'manual', manual: { type: 'https', host: '  ', port: 443 } })
    ).toBeUndefined()
  })

  it.each([0, -1, 65536, 1.5, 'abc'])('rejects an out-of-range port (%s)', (port) => {
    expect(
      sanitizeProxySettings({ mode: 'manual', manual: { type: 'http', host: 'h', port } })
    ).toBeUndefined()
  })

  it('rejects junk and unknown modes', () => {
    expect(sanitizeProxySettings(undefined)).toBeUndefined()
    expect(sanitizeProxySettings({ mode: 'automatic' })).toBeUndefined()
    expect(sanitizeProxySettings({ mode: 'manual' })).toBeUndefined()
    expect(sanitizeProxySettings('manual')).toBeUndefined()
  })

  it('keeps noProxy absent when the list is empty', () => {
    const settings = sanitizeProxySettings({
      mode: 'manual',
      manual: { type: 'socks5', host: 'proxy.example.com', port: 1080, noProxy: [] }
    })
    expect(settings).toEqual({
      mode: 'manual',
      manual: { type: 'socks5', host: 'proxy.example.com', port: 1080 }
    })
  })
})

describe('sanitizeScenarioModels', () => {
  it('keeps only known scenarios with a non-empty provider and model', () => {
    expect(
      sanitizeScenarioModels({
        'session-detail': { providerId: ' p1 ', model: 'model-a' },
        subagent: { providerId: 'p2', model: 'model-b', reasoningEffort: 'high' },
        review: { providerId: '', model: 'model-c' },
        'unknown-scenario': { providerId: 'p3', model: 'model-d' }
      })
    ).toEqual({
      'session-detail': { providerId: 'p1', model: 'model-a' },
      subagent: { providerId: 'p2', model: 'model-b', reasoningEffort: 'high' }
    })
  })

  it('returns undefined for empty or malformed payloads', () => {
    expect(sanitizeScenarioModels(undefined)).toBeUndefined()
    expect(sanitizeScenarioModels({})).toBeUndefined()
    expect(sanitizeScenarioModels({ 'session-detail': 'not-an-object' })).toBeUndefined()
    expect(sanitizeScenarioModels('nope')).toBeUndefined()
  })

  it('drops a malformed reasoning effort', () => {
    expect(
      sanitizeScenarioModels({
        review: { providerId: 'p', model: 'm', reasoningEffort: 'turbo' }
      })
    ).toEqual({ review: { providerId: 'p', model: 'm' } })
  })
})

describe('manualProxyEnvironment', () => {
  it('returns undefined before any settings are applied or when following system', () => {
    expect(manualProxyEnvironment()).toBeUndefined()
    applyProxySettings({ mode: 'system' })
    expect(manualProxyEnvironment()).toBeUndefined()
    applyProxySettings(undefined)
    expect(manualProxyEnvironment()).toBeUndefined()
  })

  it('maps an HTTP manual proxy to both alias spellings plus a loopback-safe bypass', () => {
    applyProxySettings({
      mode: 'manual',
      manual: {
        type: 'http',
        host: '127.0.0.1',
        port: 7890,
        noProxy: ['example.com']
      }
    })
    const env = manualProxyEnvironment()
    expect(env).toMatchObject({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890'
    })
    const loopback = loopbackProxyBypassEnvironment()
    expect(env?.NO_PROXY).toBe(`example.com,${loopback.NO_PROXY}`)
    expect(env?.ALL_PROXY).toBeUndefined()
  })

  it('routes SOCKS5 through ALL_PROXY only', () => {
    applyProxySettings({
      mode: 'manual',
      manual: { type: 'socks5', host: 'proxy.example.com', port: 1080 }
    })
    const env = manualProxyEnvironment()
    expect(env?.ALL_PROXY).toBe('socks5://proxy.example.com:1080')
    expect(env?.HTTP_PROXY).toBeUndefined()
    expect(env?.HTTPS_PROXY).toBeUndefined()
    expect(env?.NO_PROXY).toBe(loopbackProxyBypassEnvironment().NO_PROXY)
  })

  it('reflects the applied settings for diagnostics', () => {
    expect(proxySettingsForTest()).toBeUndefined()
    applyProxySettings({ mode: 'manual', manual: { type: 'https', host: 'h', port: 1 } })
    expect(proxySettingsForTest()).toEqual({
      mode: 'manual',
      manual: { type: 'https', host: 'h', port: 1 }
    })
  })
})
