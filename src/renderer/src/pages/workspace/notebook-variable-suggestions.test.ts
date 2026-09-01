import { describe, expect, it } from 'vitest'

import { suggestVariableNames } from './NotebookPreview'

describe('suggestVariableNames', () => {
  const variables = ['count', 'data_frame', 'mean_value', 'results', 'x']

  it('matches variable names against the trailing token prefix', () => {
    expect(suggestVariableNames('mea', variables)).toEqual(['mean_value'])
    expect(suggestVariableNames('data', variables)).toEqual(['data_frame'])
  })

  it('is case-insensitive on both sides', () => {
    expect(suggestVariableNames('COUNT', variables)).toEqual(['count'])
    expect(suggestVariableNames('Data', variables)).toEqual(['data_frame'])
  })

  it('suggests after a partial expression, not just at the start', () => {
    expect(suggestVariableNames('print(res', variables)).toEqual(['results'])
    expect(suggestVariableNames('x + coun', variables)).toEqual(['count'])
  })

  it('returns nothing for empty, numeric, or symbolic tokens', () => {
    expect(suggestVariableNames('', variables)).toEqual([])
    expect(suggestVariableNames('42', variables)).toEqual([])
    expect(suggestVariableNames('x + ', variables)).toEqual([])
    expect(suggestVariableNames('(', variables)).toEqual([])
  })

  it('caps the suggestion list', () => {
    const many = Array.from({ length: 20 }, (_, index) => `var_${index}`)
    expect(suggestVariableNames('var_', many)).toHaveLength(8)
  })

  it('returns nothing when there are no kernel variables', () => {
    expect(suggestVariableNames('count', [])).toEqual([])
  })
})
