import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { NATIVE_LOCALE_CODES, nativeLocaleCodeFrom } from '../native-locale'
import {
  BANNER_KINDS,
  renderTaskNotification,
  TASK_NOTIFICATION_COPY,
  TASK_NOTIFICATION_MAX_BODY_LENGTH,
  type TaskNotificationDescriptor
} from './task-notification-strings'

// The English wording the notification service shipped before the copy table existed, transcribed
// from its own literals. A banner is drawn by the OS, so there is no rendered output to diff: this
// pin is the only thing that keeps eight languages from being added around a silently reworded
// English column.
const PREVIOUS_EN: Array<[TaskNotificationDescriptor, string, string]> = [
  [
    { kind: 'task.completed', task: 'Plot the curve' },
    'Task completed',
    'The agent finished responding to "Plot the curve".'
  ],
  [{ kind: 'task.completed' }, 'Task completed', 'The agent finished responding.'],
  [
    { kind: 'task.needs-attention', task: 'Plot the curve', reason: 'max-tokens' },
    'Task needs attention',
    '"Plot the curve" stopped early — the answer hit the model\'s length limit.'
  ],
  [
    { kind: 'task.needs-attention', reason: 'max-tokens' },
    'Task needs attention',
    "The agent stopped early — the answer hit the model's length limit."
  ],
  [
    { kind: 'task.needs-attention', task: 'Plot the curve', reason: 'max-turns' },
    'Task needs attention',
    '"Plot the curve" paused — send a message to keep it going.'
  ],
  [
    { kind: 'task.needs-attention', task: 'Plot the curve', reason: 'refusal' },
    'Task needs attention',
    '"Plot the curve" was declined by the agent.'
  ],
  [
    { kind: 'task.needs-attention', reason: 'refusal' },
    'Task needs attention',
    'The agent declined the request.'
  ],
  [
    {
      kind: 'task.needs-attention',
      task: 'Plot the curve',
      reason: 'unclean',
      detail: ' (budget exceeded)'
    },
    'Task needs attention',
    '"Plot the curve" finished without a clean completion status (budget exceeded).'
  ],
  [
    { kind: 'task.failed', task: 'Plot the curve', detail: 'Rate limit reached' },
    'Task failed',
    '"Plot the curve" failed: Rate limit reached'
  ],
  [{ kind: 'task.failed', detail: 'Rate limit reached' }, 'Task failed', 'Rate limit reached'],
  [
    { kind: 'authorization.required', task: 'Plot the curve', detail: 'zinc search' },
    'Approval needed',
    '"Plot the curve" needs your approval: zinc search'
  ],
  [
    { kind: 'authorization.required', detail: 'zinc search' },
    'Approval needed',
    'The agent needs your approval: zinc search'
  ]
]

// Characters that only exist in the simplified set: a Traditional column that still carries one of
// these was copied from the Simplified one instead of written. Small on purpose — a fallback detector,
// not a proofreader.
const SIMPLIFIED_ONLY = [
  '务',
  '数',
  '据',
  '动',
  '开',
  '关',
  '复',
  '载',
  '应',
  '让',
  '会',
  '时',
  '间',
  '这',
  '结',
  '续',
  '讯',
  '绝',
  '长',
  '达'
]

const i18nRoot = fileURLToPath(new URL('../../../src/renderer/src/i18n/', import.meta.url))

const readDictionaryValue = (code: string, key: string): string => {
  const source = readFileSync(`${i18nRoot}${code}.ts`, 'utf8')
  const match = new RegExp(`'${key}':\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(source)

  if (!match) throw new Error(`${code}.ts has no value for ${key}`)

  return match[1]
}

// Every kind with every optional field, so no language can leave a sentence unwritten.
const SAMPLES: TaskNotificationDescriptor[] = [
  { kind: 'task.completed' },
  { kind: 'task.completed', task: 'Plot the curve' },
  { kind: 'task.needs-attention', reason: 'max-tokens' },
  { kind: 'task.needs-attention', task: 'Plot the curve', reason: 'max-turns' },
  { kind: 'task.needs-attention', reason: 'refusal' },
  {
    kind: 'task.needs-attention',
    task: 'Plot the curve',
    reason: 'unclean',
    detail: ' (budget exceeded)'
  },
  { kind: 'task.failed', detail: 'Rate limit reached' },
  { kind: 'task.failed', task: 'Plot the curve', detail: 'Rate limit reached' },
  { kind: 'authorization.required', detail: 'zinc search' },
  { kind: 'authorization.required', task: 'Plot the curve', detail: 'zinc search' }
]

describe('the banner copy table', () => {
  it('keeps the English column byte-identical to the wording it replaced', () => {
    for (const [descriptor, title, body] of PREVIOUS_EN) {
      expect(renderTaskNotification(descriptor, 'en')).toEqual({ title, body })
    }
  })

  it('has a row for every language the app ships, with no blank sentence', () => {
    expect(Object.keys(TASK_NOTIFICATION_COPY).sort()).toEqual([...NATIVE_LOCALE_CODES].sort())

    for (const code of NATIVE_LOCALE_CODES) {
      const copy = TASK_NOTIFICATION_COPY[code]
      const values = [
        copy.subject,
        copy.quotes[0],
        copy.quotes[1],
        ...Object.values(copy.titles),
        ...Object.values(copy.completed),
        ...Object.values(copy.attention),
        ...Object.values(copy.failed),
        ...Object.values(copy.approval)
      ]

      for (const value of values) expect(`${code}: ${value}`).not.toBe(`${code}: `)
    }
  })

  it('renders every kind in every language without leaving a placeholder behind', () => {
    for (const code of NATIVE_LOCALE_CODES) {
      for (const descriptor of SAMPLES) {
        const rendered = renderTaskNotification(descriptor, code)
        expect(rendered.title.length).toBeGreaterThan(0)
        expect(rendered.body.length).toBeGreaterThan(0)
        // `{task}` / `{detail}` left in place would mean the value never reached the sentence.
        expect(rendered.body).not.toMatch(/\{(task|detail|subject|reason)\}/)
      }
    }
  })

  it('samples every kind the banner taxonomy allows', () => {
    // A kind that exists in shared/notifications but never shows up in the samples would pass the
    // renderers above without any language ever being checked for it.
    expect([...new Set(SAMPLES.map((descriptor) => descriptor.kind))].sort()).toEqual(
      [...BANNER_KINDS].sort()
    )
  })

  it('does not ship the English sentence to the other eight languages', () => {
    for (const descriptor of SAMPLES) {
      // A bare failure body IS the provider's error text — there is no sentence to translate, and
      // inventing one would put words in the provider's mouth. Every sentence-bearing case is checked.
      if (descriptor.kind === 'task.failed' && !descriptor.task) continue

      const english = renderTaskNotification(descriptor, 'en')

      for (const code of NATIVE_LOCALE_CODES) {
        if (code === 'en') continue

        const translated = renderTaskNotification(descriptor, code)
        expect(`${code} ${descriptor.kind} body: ${translated.body}`).not.toBe(
          `${code} ${descriptor.kind} body: ${english.body}`
        )
      }
    }
  })

  it('keeps the Traditional column Traditional', () => {
    for (const descriptor of SAMPLES) {
      const traditional = renderTaskNotification(descriptor, 'zh-Hant').body

      for (const character of SIMPLIFIED_ONLY) {
        expect(traditional.includes(character) ? `zh-Hant: ${traditional}` : 'ok').toBe('ok')
      }
    }
  })

  it('quotes a task name in the reader’s own punctuation', () => {
    // English is the pinned exception: its ASCII quotes are what the previous wording used.
    expect(renderTaskNotification({ kind: 'task.completed', task: 'X' }, 'en').body).toContain(
      '"X"'
    )
    expect(renderTaskNotification({ kind: 'task.completed', task: 'X' }, 'zh').body).toContain(
      '「X」'
    )
    expect(renderTaskNotification({ kind: 'task.completed', task: 'X' }, 'de').body).toContain(
      '„X“'
    )
  })

  it('caps the body the way the English one was capped', () => {
    const long = 'A'.repeat(400)
    const rendered = renderTaskNotification({ kind: 'task.completed', task: long }, 'de')

    expect(rendered.body.length).toBe(TASK_NOTIFICATION_MAX_BODY_LENGTH)
    expect(rendered.body.endsWith('…')).toBe(true)
  })

  it('cascades the OS locale the way the rest of main does', () => {
    // Not a second cascade: the same tags native-locale.ts already maps must land on rows that are
    // actually rendered, so 'zh-TW' cannot fall through to the English column.
    expect(nativeLocaleCodeFrom('zh-TW')).toBe('zh-Hant')
    expect(
      renderTaskNotification({ kind: 'task.completed' }, nativeLocaleCodeFrom('zh-TW')).body
    ).toBe(renderTaskNotification({ kind: 'task.completed' }, 'zh-Hant').body)
    expect(
      renderTaskNotification({ kind: 'task.completed' }, nativeLocaleCodeFrom('pt-BR')).title
    ).toBe('Task completed')
  })

  it('uses the message centre’s own words for the two titles it already translates', () => {
    // The same event shows up as an inbox card and as a banner; a different word in each place reads
    // as two different things. Read from the dictionaries rather than restated here.
    const pins: Array<[string, (code: (typeof NATIVE_LOCALE_CODES)[number]) => string]> = [
      ['notifications.taskCompleted', (code) => TASK_NOTIFICATION_COPY[code].titles.completed],
      ['notifications.taskFailed', (code) => TASK_NOTIFICATION_COPY[code].titles.failed]
    ]

    for (const [key, tableValue] of pins) {
      for (const code of NATIVE_LOCALE_CODES) {
        expect(`${code} ${key}: ${tableValue(code)}`).toBe(
          `${code} ${key}: ${readDictionaryValue(code, key)}`
        )
      }
    }
  })
})
