import { describe, expect, it } from 'vitest'

import type { VisionModelOption } from './vision-model-options'
import { selectableVisionOptions } from './vision-model-options'

const option = (providerId: string, model: string): VisionModelOption => ({
  provider: { id: providerId } as VisionModelOption['provider'],
  model
})

describe('selectableVisionOptions', () => {
  it('keeps the candidate list as-is when the saved pair is already in it', () => {
    const options = [option('p1', 'vision-a'), option('p1', 'vision-b')]

    expect(selectableVisionOptions(option('p1', 'vision-a'), options)).toBe(options)
  })

  it('adds a saved pair the candidate rule no longer produces, so it stays pickable', () => {
    const saved = option('p1', 'vision-exp')
    const result = selectableVisionOptions(saved, [])

    expect(result).toEqual([saved])
  })

  it('does not duplicate the saved pair when the list already carries it', () => {
    const saved = option('p1', 'vision-exp')
    const result = selectableVisionOptions(saved, [saved, option('p2', 'other')])

    expect(result).toHaveLength(2)
    expect(result.filter((candidate) => candidate.model === 'vision-exp')).toHaveLength(1)
  })

  it('returns nothing when there is no saved pair and no candidates', () => {
    expect(selectableVisionOptions(undefined, [])).toEqual([])
  })
})
