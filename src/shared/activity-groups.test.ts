import { describe, expect, it } from 'vitest'

import {
  getActivityGroupTitleFromToolEvent,
  isActivityGroupToolEvent,
  sanitizeActivityGroupTitle
} from './activity-groups'

describe('activity group tool events', () => {
  it.each([
    'mcp__purescience-activity__begin_activity_group',
    'purescience-activity_begin_activity_group',
    'mcp__open_science_activity__begin_activity_group',
    'mcp.purescience-activity.begin_activity_group',
    'open_science_activity_begin_activity_group'
  ])('recognizes framework tool identity %s', (providerToolName) => {
    expect(isActivityGroupToolEvent({ providerToolName })).toBe(true)
  })

  it('extracts native and Codex-wrapped arguments', () => {
    expect(
      getActivityGroupTitleFromToolEvent({
        providerToolName: 'mcp__purescience-activity__begin_activity_group',
        rawInput: { title: 'Inspect the implementation.' }
      })
    ).toBe('Inspect the implementation')
    expect(
      getActivityGroupTitleFromToolEvent({
        rawInput: {
          server: 'purescience-activity',
          tool: 'begin_activity_group',
          arguments: { title: 'Apply the focused change' }
        }
      })
    ).toBe('Apply the focused change')
  })

  it('does not trust a bare leaf name without a server-qualified identity', () => {
    expect(isActivityGroupToolEvent({ providerToolName: 'begin_activity_group' })).toBe(false)
    expect(
      isActivityGroupToolEvent({
        providerToolName: 'mcp__purescience-activity__begin_activity_group'
      })
    ).toBe(true)
  })

  it('bounds and normalizes titles', () => {
    expect(sanitizeActivityGroupTitle(`Title: "${'x'.repeat(100)}."`)?.length).toBe(80)

    const unicodeTitle = sanitizeActivityGroupTitle(`Title: "${'🌟'.repeat(100)}."`)
    expect(unicodeTitle).toBe('🌟'.repeat(80))
    expect(Array.from(unicodeTitle ?? '')).toHaveLength(80)
  })
})
