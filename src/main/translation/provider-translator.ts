// The real translator: one paragraph in, one translation out, over the provider the app is already configured
// with (same shape as `settings/list-models.ts` — an explicit target, an injected fetch, a bounded timeout, and
// a result that is never a throw).
//
// Failure is named rather than thrown because a failed paragraph must be recorded as failed and retried on the
// next run; a throw here would abort a whole document over one bad request. The key never appears in a reason,
// and a provider's error body is truncated before it is quoted, so a reason string is always safe to log.

import type { TranslationTranslator, TranslateOutcome } from './engine'

export const DEFAULT_TRANSLATION_TIMEOUT_MS = 60_000

/** Quoted provider bodies are cut here: an error page can be arbitrarily long and may echo request content. */
export const PROVIDER_ERROR_BODY_LIMIT = 200

export type ProviderTranslatorTarget = {
  /** Full OpenAI-compatible `chat/completions` endpoint URL. */
  url: string
  key?: string
  model: string
}

export type ProviderTranslatorDeps = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** The language paragraphs are translated into. Named in the prompt so the request is self-describing. */
  targetLanguage?: string
}

const SYSTEM_PROMPT =
  'You are a scientific translation engine. Translate the user-provided scientific text into {language}. ' +
  'Preserve domain terminology (use the standard established term for the field), numbers, units, gene and ' +
  'protein names, chemical names, and citation markers exactly as they appear. Do not summarize, explain, ' +
  'answer, or add anything. Return only the translation of the text, with no preamble and no quotes. If the ' +
  'text is already in {language}, return it unchanged.'

/** Reads the first assistant message's text out of a chat-completions payload. Returns null when absent. */
export const parseChatCompletionText = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return null
  const message = (first as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  if (typeof content !== 'string') return null
  return content.trim() === '' ? null : content
}

const quote = (text: string): string =>
  text.length <= PROVIDER_ERROR_BODY_LIMIT ? text : `${text.slice(0, PROVIDER_ERROR_BODY_LIMIT)}…`

// A provider may echo the credential it was sent back inside an error body or message. Reasons are logged, so
// the key is removed before anything is quoted.
const redact = (text: string, key?: string): string =>
  key === undefined || key === '' ? text : text.split(key).join('[redacted]')

/**
 * Builds a translator bound to one provider target. Every unit is one request: paragraph-level units are small,
 * and a per-unit request is what makes a failure local to the paragraph that caused it.
 */
export const createProviderTranslator = (
  target: ProviderTranslatorTarget,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TRANSLATION_TIMEOUT_MS,
    targetLanguage = 'Simplified Chinese'
  }: ProviderTranslatorDeps = {}
): TranslationTranslator => {
  const system = SYSTEM_PROMPT.replaceAll('{language}', targetLanguage)

  return async (unit): Promise<TranslateOutcome> => {
    let url: string
    try {
      url = new URL(target.url).toString()
    } catch {
      return { ok: false, reason: 'invalid-endpoint' }
    }

    if (target.model.trim() === '') return { ok: false, reason: 'no-model' }

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (target.key) {
      // Sent as both bearer and x-api-key so either auth scheme is satisfied (the vendor registry carries
      // dual-endpoint vendors), exactly as the model-list request does.
      headers.authorization = `Bearer ${target.key}`
      headers['x-api-key'] = target.key
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: target.model,
          stream: false,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: unit.text }
          ]
        })
      })

      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: `unauthorized (${response.status})` }
      }
      if (response.status < 200 || response.status >= 300) {
        let detail = ''
        try {
          detail = quote(redact((await response.text()).trim(), target.key))
        } catch {
          detail = ''
        }
        return {
          ok: false,
          reason: `http-error (${response.status})${detail === '' ? '' : `: ${detail}`}`
        }
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { ok: false, reason: 'malformed-response' }
      }

      const text = parseChatCompletionText(body)
      if (text === null) return { ok: false, reason: 'empty-response' }

      return { ok: true, text }
    } catch (error) {
      const name = (error as { name?: unknown }).name
      if (name === 'AbortError') return { ok: false, reason: `timeout after ${timeoutMs}ms` }
      return {
        ok: false,
        reason: `network-error: ${redact(error instanceof Error ? error.message : String(error), target.key)}`
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
