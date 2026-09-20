import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// The conversation header is load-bearing for automation and for screen readers: five end-to-end
// specs find it as `heading { name: 'New conversation' }`. The title became a button so the session
// information card could open from it — a button that carries its own aria-label would replace the
// heading's accessible name with that label, which broke exactly those specs on CI once. This guard
// keeps the name coming from the visible title text.
//
// It is a source assertion on purpose: the alternative (mounting the whole panel) needs the entire
// workspace store, and the contract being protected is about markup shape, not runtime behaviour.

const source = readFileSync(join(__dirname, 'ConversationPanel.tsx'), 'utf8')

describe('conversation header accessible name', () => {
  it('keeps the heading name derived from the session title', () => {
    const heading = source.slice(source.indexOf('<h1'), source.indexOf('</h1>'))
    expect(heading).toContain('data-testid="conversation-title-button"')
    // No aria-label anywhere inside the heading: the visible title text is the accessible name.
    expect(heading).not.toContain('aria-label')
  })

  it('opens the information card from a button that only adds state, not a new name', () => {
    const button = source.slice(
      source.indexOf('data-testid="conversation-title-button"'),
      source.indexOf('{activeSession?.title ??')
    )
    expect(button).toContain('aria-expanded={isInfoCardOpen}')
    expect(button).not.toContain('aria-label')
    // The visible title is the button's content, so the heading reads as the session title.
    expect(source).toContain('{activeSession?.title ??')
    expect(source).toContain('<SessionInfoCard')
  })
})
