import { describe, expect, it } from 'vitest'
import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../types'
import { EXPRESSION_PANGLAODB_TOOLS } from './expression-panglaodb'

const tool = (id: string): ToolDescriptor => EXPRESSION_PANGLAODB_TOOLS.find((t) => t.id === id)!

// PanglaoDB tools are fully offline — no fetch is ever made; the engine's fetchImpl must stay unused.
const run = async (id: string, args: Record<string, unknown>): Promise<unknown> => {
  const engine = new ParserEngine({})
  return engine.call(tool(id), args, {})
}

describe('expression-panglaodb', () => {
  it('exports the 3 tools in order, all under the expression connector', () => {
    expect(EXPRESSION_PANGLAODB_TOOLS.map((t) => t.id)).toEqual([
      'panglaodb_markers_for_cell_type',
      'panglaodb_cell_type_for_gene',
      'panglaodb_list_cell_types'
    ])
    expect(EXPRESSION_PANGLAODB_TOOLS.every((t) => t.connector === 'expression')).toBe(true)
  })

  it('panglaodb_markers_for_cell_type: exact match returns markers for the cell type', async () => {
    const out = (await run('panglaodb_markers_for_cell_type', {
      cell_type: 'microglia'
    })) as {
      match: string
      count: number
      cell_types: Array<{ cell_type: string; markers: string[] }>
    }
    expect(out.match).toBe('exact')
    expect(out.count).toBe(1)
    expect(out.cell_types[0]!.cell_type).toBe('Microglia')
    expect(out.cell_types[0]!.markers).toContain('P2RY12')
    expect(out.cell_types[0]!.markers).toContain('TMEM119')
  })

  it('panglaodb_markers_for_cell_type: partial match falls back to substring', async () => {
    const out = (await run('panglaodb_markers_for_cell_type', {
      cell_type: 'T cell'
    })) as { match: string; count: number }
    expect(out.match).toBe('partial')
    expect(out.count).toBeGreaterThanOrEqual(3) // T cells, CD4+, CD8+, Tregs
  })

  it('panglaodb_markers_for_cell_type: unknown type returns match:none with empty list', async () => {
    const out = (await run('panglaodb_markers_for_cell_type', {
      cell_type: 'nonexistent-cell'
    })) as { match: string; count: number; cell_types: unknown[] }
    expect(out.match).toBe('none')
    expect(out.count).toBe(0)
    expect(out.cell_types).toEqual([])
  })

  it('panglaodb_cell_type_for_gene: reverse lookup finds expressing cell types', async () => {
    const out = (await run('panglaodb_cell_type_for_gene', { gene: 'GFAP' })) as {
      gene: string
      count: number
      cell_types: Array<{ cell_type: string; organ: string }>
    }
    expect(out.gene).toBe('GFAP')
    expect(out.count).toBe(1)
    expect(out.cell_types[0]!.cell_type).toBe('Astrocytes')
  })

  it('panglaodb_cell_type_for_gene: unknown gene returns empty', async () => {
    const out = (await run('panglaodb_cell_type_for_gene', { gene: 'XYZ123' })) as { count: number }
    expect(out.count).toBe(0)
  })

  it('panglaodb_list_cell_types: lists all cell types, optional organ filter', async () => {
    const all = (await run('panglaodb_list_cell_types', {})) as { count: number }
    expect(all.count).toBeGreaterThan(30)
    const blood = (await run('panglaodb_list_cell_types', { organ: 'Blood' })) as {
      count: number
      cell_types: Array<{ cell_type: string }>
    }
    expect(blood.count).toBeGreaterThan(5)
    expect(blood.cell_types.some((c) => c.cell_type === 'T cells')).toBe(true)
  })
})
