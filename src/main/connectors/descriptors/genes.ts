import type { ToolDescriptor } from '../types'
import { GENES_PROTEINS_TOOLS } from './genes-proteins'
import { GENES_ONTOLOGY_TOOLS } from './genes-ontology'
import { GENES_REACTOME_TOOLS } from './genes-reactome'
import { GENES_ALLIANCE_TOOLS } from './genes-alliance'
import { GENES_MONARCH_TOOLS } from './genes-monarch'
import { PATHWAY_COMMONS_TOOLS } from './pathway-commons'

// "Genes & Ontologies" connector: gene/protein identity (mygene.info, UniProt) plus ontology
// terms (OLS4), GO annotations (QuickGO) and Reactome pathways. Tools are split across descriptor
// files by source API; this module aggregates them in the connector's display order.
const POOL: ToolDescriptor[] = [
  ...GENES_PROTEINS_TOOLS,
  ...GENES_ONTOLOGY_TOOLS,
  ...GENES_REACTOME_TOOLS,
  ...GENES_ALLIANCE_TOOLS,
  ...GENES_MONARCH_TOOLS,
  ...PATHWAY_COMMONS_TOOLS
]

const ORDER = [
  'query_genes',
  'list_ontologies',
  'search_ontology_terms',
  'get_ontology_term',
  'get_go_annotations',
  'get_uniprot_entries',
  'map_uniprot_ids',
  'map_reactome_pathways',
  'alliance_search_genes',
  'monarch_phenotype_associations',
  'search_pathway_commons'
]

export const GENES_TOOLS: ToolDescriptor[] = ORDER.map(
  (id) => POOL.find((t) => t.id === id) as ToolDescriptor
)
