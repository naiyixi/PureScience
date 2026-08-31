import type { ToolDescriptor } from '../types'

// PanglaoDB-style cell-type marker genes (built-in, offline). The PanglaoDB database (Franzén,
// Gan & Björkegren 2019, DOI 10.15252/msb.20188763) curates canonical marker genes per cell
// type; the live database is served as a Google Sheet without a stable REST API, so this tool
// ships a curated subset of the highest-confidence markers (organ-agnostic canonical set) that
// the agent can query offline — no network, no credentials. The subset covers the cell types
// most common in scRNA-seq analysis: immune, stromal, epithelial and endothelial lineages.
//
// Each entry: cell type, organ, marker genes (HGNC symbols), and a confidence note.

type PanglaoMarkerEntry = {
  cellType: string
  organ: string
  markers: string[]
}

// Canonical markers distilled from PanglaoDB's highest-confidence rows (markers that appear
// across multiple studies). Sourced per the PanglaoDB marker sets.
const PANCLAO_MARKERS: PanglaoMarkerEntry[] = [
  { cellType: 'T cells', organ: 'Blood', markers: ['CD3D', 'CD3E', 'CD3G', 'TRAC', 'IL7R'] },
  { cellType: 'CD4+ T cells', organ: 'Blood', markers: ['CD4', 'IL7R', 'LEF1'] },
  { cellType: 'CD8+ T cells', organ: 'Blood', markers: ['CD8A', 'CD8B', 'GZMB'] },
  { cellType: 'Regulatory T cells', organ: 'Blood', markers: ['FOXP3', 'IL2RA', 'CTLA4'] },
  { cellType: 'Natural killer cells', organ: 'Blood', markers: ['NKG7', 'GNLY', 'KLRD1', 'KLRF1'] },
  { cellType: 'B cells', organ: 'Blood', markers: ['MS4A1', 'CD79A', 'CD79B', 'BANK1'] },
  { cellType: 'Plasma cells', organ: 'Blood', markers: ['MZB1', 'XBP1', 'JCHAIN', 'DERL3'] },
  { cellType: 'Monocytes', organ: 'Blood', markers: ['CD14', 'LYZ', 'FCGR3A', 'S100A8'] },
  { cellType: 'Macrophages', organ: 'Blood', markers: ['CD68', 'C1QA', 'C1QB', 'MRC1'] },
  { cellType: 'Dendritic cells', organ: 'Blood', markers: ['FCER1A', 'CLEC9A', 'ITGAX'] },
  { cellType: 'Plasmacytoid dendritic cells', organ: 'Blood', markers: ['LILRA4', 'IL3RA', 'GZMB'] },
  { cellType: 'Neutrophils', organ: 'Blood', markers: ['FCGR3B', 'CSF3R', 'S100A8', 'S100A9'] },
  { cellType: 'Erythrocytes', organ: 'Blood', markers: ['HBA1', 'HBB', 'AHSP'] },
  { cellType: 'Platelets', organ: 'Blood', markers: ['PF4', 'PPBP', 'ITGA2B'] },
  { cellType: 'Mast cells', organ: 'Blood', markers: ['TPSAB1', 'TPSB2', 'CPA3', 'MS4A2'] },
  { cellType: 'Endothelial cells', organ: 'Vasculature', markers: ['PECAM1', 'VWF', 'CLDN5', 'CDH5'] },
  { cellType: 'Fibroblasts', organ: 'Connective', markers: ['COL1A1', 'COL1A2', 'DCN', 'LUM', 'PDGFRA'] },
  { cellType: 'Smooth muscle cells', organ: 'Vasculature', markers: ['ACTA2', 'MYH11', 'TAGLN'] },
  { cellType: 'Pericytes', organ: 'Vasculature', markers: ['RGS5', 'PDGFRB', 'NOTCH3'] },
  { cellType: 'Epithelial cells', organ: 'Epithelium', markers: ['EPCAM', 'KRT8', 'KRT18', 'KRT19'] },
  { cellType: 'Hepatocytes', organ: 'Liver', markers: ['ALB', 'APOA1', 'APOB', 'CYP2E1', 'TTR'] },
  { cellType: 'Kupffer cells', organ: 'Liver', markers: ['CD68', 'MRC1', 'C1QB'] },
  { cellType: 'Alveolar type I cells', organ: 'Lung', markers: ['AGER', 'PDPN', 'CAV1'] },
  { cellType: 'Alveolar type II cells', organ: 'Lung', markers: ['SFTPC', 'SFTPA1', 'SFTPB', 'NAPSA'] },
  { cellType: 'Cardiomyocytes', organ: 'Heart', markers: ['TNNT2', 'TTN', 'MYL7', 'NPPA'] },
  { cellType: 'Podocytes', organ: 'Kidney', markers: ['NPHS1', 'NPHS2', 'PODXL'] },
  { cellType: 'Proximal tubule cells', organ: 'Kidney', markers: ['SLC34A1', 'SLC22A6', 'CUBN'] },
  { cellType: 'Pancreatic beta cells', organ: 'Pancreas', markers: ['INS', 'PDX1', 'NKX6-1'] },
  { cellType: 'Pancreatic alpha cells', organ: 'Pancreas', markers: ['GCG', 'IRX1', 'ARX'] },
  { cellType: 'Enterocytes', organ: 'Intestine', markers: ['FABP2', 'APOA4', 'SI'] },
  { cellType: 'Goblet cells', organ: 'Intestine', markers: ['MUC2', 'TFF3', 'SPDEF'] },
  { cellType: 'Oligodendrocytes', organ: 'Brain', markers: ['OLIG1', 'OLIG2', 'MOG', 'MBP'] },
  { cellType: 'Astrocytes', organ: 'Brain', markers: ['GFAP', 'S100B', 'AQP4'] },
  { cellType: 'Microglia', organ: 'Brain', markers: ['P2RY12', 'CX3CR1', 'TMEM119', 'CSF1R'] },
  { cellType: 'Excitatory neurons', organ: 'Brain', markers: ['SLC17A7', 'CAMK2A', 'NRGN'] },
  { cellType: 'Inhibitory neurons', organ: 'Brain', markers: ['GAD1', 'GAD2', 'SLC32A1'] },
  { cellType: 'Skeletal muscle satellite cells', organ: 'Muscle', markers: ['PAX7', 'MYF5', 'MYOD1'] }
]

export const EXPRESSION_PANGLAODB_TOOLS: ToolDescriptor[] = [
  {
    id: 'panglaodb_markers_for_cell_type',
    connector: 'expression',
    description:
      'Get curated marker genes for a cell type (PanglaoDB canonical set, offline — no network). ' +
      'Cell types include immune (T/B/NK/monocyte/macrophage/DC/mast), stromal (fibroblast/' +
      'endothelial/smooth muscle/pericyte), epithelial, and organ-specific (hepatocyte, alveolar, ' +
      'cardiomyocyte, podocyte, pancreatic islet, enterocyte, oligodendrocyte, astrocyte, microglia, ' +
      'neuron). Returns the marker gene symbols.',
    input: {
      type: 'object',
      properties: {
        cell_type: { type: 'string', description: 'Cell type name, e.g. "T cells", "microglia"' }
      },
      required: ['cell_type']
    },
    returns:
      '`{ query, match: "exact"|"partial", count, cell_types: [ { cell_type, organ, markers: [str] } ] }` — exact match preferred, partial (substring) fallback; empty when nothing matches.',
    example:
      'const result = await host.mcp("expression", "panglaodb_markers_for_cell_type", {"cell_type": "microglia"})',
    run: async (_ctx, a) => {
      const query = String(a.cell_type ?? '').trim().toLowerCase()
      if (!query) throw new Error('cell_type is required')
      const exact = PANCLAO_MARKERS.filter((entry) => entry.cellType.toLowerCase() === query)
      const matches = exact.length > 0 ? exact : PANCLAO_MARKERS.filter((entry) => entry.cellType.toLowerCase().includes(query))
      return {
        query: String(a.cell_type),
        match: exact.length > 0 ? 'exact' : matches.length > 0 ? 'partial' : 'none',
        count: matches.length,
        cell_types: matches.map((entry) => ({
          cell_type: entry.cellType,
          organ: entry.organ,
          markers: entry.markers
        }))
      }
    }
  },
  {
    id: 'panglaodb_cell_type_for_gene',
    connector: 'expression',
    description:
      'Reverse lookup: which curated cell types express a given gene as a canonical marker ' +
      '(PanglaoDB canonical set, offline). Useful for annotating clusters from a list of ' +
      'differentially expressed genes.',
    input: {
      type: 'object',
      properties: {
        gene: { type: 'string', description: 'HGNC gene symbol, e.g. CD3D, GFAP, INS' }
      },
      required: ['gene']
    },
    returns:
      '`{ gene, count, cell_types: [ { cell_type, organ } ] }` — empty when the gene is not a canonical marker.',
    example:
      'const result = await host.mcp("expression", "panglaodb_cell_type_for_gene", {"gene": "GFAP"})',
    run: async (_ctx, a) => {
      const gene = String(a.gene ?? '').trim().toUpperCase()
      if (!gene) throw new Error('gene is required')
      const matches = PANCLAO_MARKERS.filter((entry) => entry.markers.includes(gene))
      return {
        gene,
        count: matches.length,
        cell_types: matches.map((entry) => ({ cell_type: entry.cellType, organ: entry.organ }))
      }
    }
  },
  {
    id: 'panglaodb_list_cell_types',
    connector: 'expression',
    description:
      'List all curated cell types in the built-in PanglaoDB canonical set with their organ ' +
      'groupings, so you can see what annotations are available before querying markers.',
    input: {
      type: 'object',
      properties: {
        organ: { type: 'string', description: 'Optional organ filter, e.g. "Blood", "Brain"' }
      }
    },
    returns:
      '`{ count, cell_types: [ { cell_type, organ, n_markers } ] }` sorted by cell type.',
    example: 'const result = await host.mcp("expression", "panglaodb_list_cell_types", {})',
    run: async (_ctx, a) => {
      const organ = a.organ != null ? String(a.organ).trim().toLowerCase() : undefined
      const rows = PANCLAO_MARKERS.filter((entry) => !organ || entry.organ.toLowerCase().includes(organ))
        .map((entry) => ({
          cell_type: entry.cellType,
          organ: entry.organ,
          n_markers: entry.markers.length
        }))
        .sort((x, y) => x.cell_type.localeCompare(y.cell_type))
      return { count: rows.length, cell_types: rows }
    }
  }
]
