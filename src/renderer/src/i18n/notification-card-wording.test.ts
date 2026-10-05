import { describe, expect, it } from 'vitest'

import {
  BACKGROUND_RESULT_NEEDS_ATTENTION_SUMMARY,
  BACKGROUND_RESULT_NEEDS_ATTENTION_TITLE
} from '../../../shared/notifications'
import { en } from './en'

// The message centre records a card's wording once, in one canonical language, and the renderer maps that
// string to the interface language. An English screen therefore renders the dictionary value, not the
// canonical string, so the two have to say the same thing: otherwise the same card reads one way where it
// is stored and another way on screen — and the drift is invisible, because both sides render something.
describe('message-centre card wording', () => {
  it('renders the canonical English card strings verbatim', () => {
    expect(en['notifications.deliveryNeedsAttention']).toBe(
      BACKGROUND_RESULT_NEEDS_ATTENTION_TITLE
    )
    expect(en['notifications.deliveryNeedsAttentionDesc']).toBe(
      BACKGROUND_RESULT_NEEDS_ATTENTION_SUMMARY
    )
  })
})
