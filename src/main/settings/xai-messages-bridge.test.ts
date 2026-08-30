import { describe, expect, it } from 'vitest'

import {
  toAnthropicResponse,
  toResponsesRequest
} from './xai-messages-bridge'

describe('toResponsesRequest (Anthropic Messages → OpenAI Responses)', () => {
  it('translates a plain chat request', () => {
    const { body, stream } = toResponsesRequest(
      {
        model: 'grok-4.6',
        system: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' }
        ],
        max_tokens: 2048,
        stream: false
      },
      'grok-4.6'
    )!
    expect(stream).toBe(false)
    expect(body.model).toBe('grok-4.6')
    expect(body.instructions).toBe('You are a helpful assistant.')
    expect(body.max_output_tokens).toBe(2048)
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi there!' }] }
    ])
  })

  it('maps tool results to function_call_output items after the tool-calling assistant turn', () => {
    const { body } = toResponsesRequest(
      {
        model: 'grok-4.6',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me look that up.' },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'web_search',
                input: { query: 'xAI API' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: '4 results'
              }
            ]
          }
        ]
      },
      'grok-4.6'
    )!
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Let me look that up.' }]
      },
      {
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'web_search',
        arguments: '{"query":"xAI API"}'
      },
      { type: 'function_call_output', call_id: 'toolu_1', output: '4 results' }
    ])
  })

  it('translates Anthropic tools into Responses function tools', () => {
    const { body } = toResponsesRequest(
      {
        model: 'grok-4.6',
        messages: [{ role: 'user', content: 'Run a tool' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Look up weather',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } }
          }
        ]
      },
      'grok-4.6'
    )!
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Look up weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } }
      }
    ])
  })

  it('keeps streaming on when the Anthropic client requested a stream', () => {
    const { body, stream } = toResponsesRequest(
      { model: 'grok-4.6', messages: [{ role: 'user', content: 'Hi' }], stream: true },
      'grok-4.6'
    )!
    expect(stream).toBe(true)
    expect(body.stream).toBe(true)
  })

  it('rejects non-object bodies', () => {
    expect(toResponsesRequest('nope', 'grok-4.6')).toBeUndefined()
    expect(toResponsesRequest(null, 'grok-4.6')).toBeUndefined()
  })
})

describe('toAnthropicResponse (OpenAI Responses → Anthropic Messages)', () => {
  it('translates a text response', () => {
    const out = toAnthropicResponse(
      {
        id: 'resp_1',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi!' }] }],
        usage: { input_tokens: 12, output_tokens: 3 }
      },
      'grok-4.6'
    )
    expect(out).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'grok-4.6',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hi!' }],
      usage: { input_tokens: 12, output_tokens: 3 }
    })
  })

  it('translates function calls into tool_use blocks with parsed arguments', () => {
    const out = toAnthropicResponse(
      {
        id: 'resp_2',
        output: [
          {
            type: 'function_call',
            call_id: 'fc_1',
            name: 'get_weather',
            arguments: '{"city":"Beijing"}'
          }
        ]
      },
      'grok-4.6'
    )
    expect(out.content).toEqual([
      { type: 'tool_use', id: 'fc_1', name: 'get_weather', input: { city: 'Beijing' } }
    ])
    expect(out.stop_reason).toBe('tool_use')
  })

  it('survives malformed arguments', () => {
    const out = toAnthropicResponse(
      {
        id: 'resp_3',
        output: [{ type: 'function_call', call_id: 'fc_2', name: 'f', arguments: 'not json' }]
      },
      'grok-4.6'
    )
    expect(out.content[0]).toMatchObject({ type: 'tool_use', input: {} })
  })
})
