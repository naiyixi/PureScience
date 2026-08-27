// External-source verification for the reviewer: fetches a cited URL over Electron's Chromium
// network stack (honoring the system/VPN proxy, like every other outbound fetch in the app) and
// returns a bounded plain-text extract for the reviewer to compare against the audited turn's claims.
// Deliberately NOT a full document reader: no scripts execute (JSDOM does not run them), no
// subresources load, and the returned text is capped so a single page cannot blow the reviewer's
// context window.

import { JSDOM } from 'jsdom'

import { netFetchStandard } from '../skills/net-fetch'
import { isAllowedExternalUrl } from '../navigation-policy'
import type { SourceFetchResult } from './host-sdk'
import { createLogger } from '../logger'

const log = createLogger('reviewer:fetch-source')

// A fetch that is hung, throttled, or pointed at a giant page must not pin the reviewer session.
const FETCH_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 2_000_000
const MAX_EXTRACT_CHARS = 60_000

const toPlainText = (html: string, url: string): { title?: string; text: string } => {
  const dom = new JSDOM(html, { url })
  const document = dom.window.document
  const title = document.title?.trim() || undefined

  // jsdom does not implement innerText; textContent approximates it after dropping non-content
  // elements. Scripts never execute under JSDOM, so their payloads are inert either way.
  for (const selector of ['script', 'style', 'noscript', 'template', 'svg']) {
    for (const node of document.querySelectorAll(selector)) node.remove()
  }

  const text = (document.body?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()

  dom.window.close()
  return { title, text }
}

// Builds the injected fetch used by ReviewerHostServer.fetchSource. Keeping the fetch behind an
// injected function lets host tests substitute a stub; this factory is the production binding.
export const createExternalSourceFetcher = (): ((url: string) => Promise<SourceFetchResult>) => {
  return async (url: string): Promise<SourceFetchResult> => {
    // Only http(s) pages are fetchable evidence. mailto: passes the external-navigation allowlist
    // (it is a legitimate "open in browser" target) but is not a fetchable page.
    if (!isAllowedExternalUrl(url)) {
      throw new Error(`Only http(s) URLs may be fetched for verification: ${url}`)
    }
    const protocol = new URL(url).protocol
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`Only http(s) URLs may be fetched for verification: ${url}`)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
      const response = await netFetchStandard(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          // Fetching as a plain reader keeps responses comparable to what a user's browser shows.
          accept: 'text/html,text/plain;q=0.9,*/*;q=0.8',
          'user-agent': 'PureScience-Reviewer/1.0'
        }
      })

      if (!response.ok) {
        throw new Error(`Fetch failed: HTTP ${response.status} ${response.statusText}`)
      }

      const contentLength = Number(response.headers.get('content-length') ?? 0)
      if (contentLength > MAX_RESPONSE_BYTES) {
        throw new Error(
          `Source too large to verify (${contentLength} bytes; limit ${MAX_RESPONSE_BYTES}).`
        )
      }

      const html = await response.text()
      const { title, text } = toPlainText(html, response.url ?? url)

      const truncated = text.length > MAX_EXTRACT_CHARS
      const bounded = truncated ? text.slice(0, MAX_EXTRACT_CHARS) : text

      log.info('fetch_source verified', {
        url,
        finalUrl: response.url ?? url,
        title,
        chars: bounded.length,
        truncated
      })

      return {
        url,
        finalUrl: response.url ?? url,
        title,
        text: bounded,
        truncated
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
