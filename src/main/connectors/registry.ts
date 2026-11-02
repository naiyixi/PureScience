import { BIOMART_TOOLS } from './descriptors/biomart'
import { BIORXIV_TOOLS } from './descriptors/biorxiv'
import { CANCER_MODELS_TOOLS } from './descriptors/cancer-models'
import { CELLGUIDE_TOOLS } from './descriptors/cellguide'
import { DELEGATE_TOOLS } from './descriptors/delegate-tasks'
import { CHEMBL_TOOLS } from './descriptors/chembl'
import { CHEMISTRY_TOOLS } from './descriptors/chemistry'
import { CLINICAL_GENOMICS_TOOLS } from './descriptors/clinical-genomics'
import { CLINICAL_TRIALS_TOOLS } from './descriptors/clinical-trials'
import { DRUG_REGULATORY_TOOLS } from './descriptors/drug-regulatory'
import { EXPRESSION_TOOLS } from './descriptors/expression'
import { GENES_ENRICHR_TOOLS } from './descriptors/genes-enrichr'
import { GENES_GPROFILER_TOOLS } from './descriptors/genes-gprofiler'
import { GENES_TOOLS } from './descriptors/genes'
import { GENOMES_NCBI_TOOLS } from './descriptors/genomes-ncbi'
import { GENOMES_TOOLS } from './descriptors/genomes'
import { HUMAN_GENETICS_TOOLS } from './descriptors/human-genetics'
import { IMMUNE_EPITOPES_TOOLS } from './descriptors/immune-epitopes'
import { LIPID_MAPS_TOOLS } from './descriptors/lipid-maps'
import { LITERATURE_TOOLS } from './descriptors/literature'
import { MOLECULE_TOOLS } from './descriptors/molecule'
import { OMNIPATH_TOOLS } from './descriptors/omnipath'
import { OMICS_ARCHIVES_TOOLS } from './descriptors/omics-archives'
import { OMICS_ENA_TOOLS } from './descriptors/omics-ena'
import { PROTEIN_ANNOTATION_TOOLS } from './descriptors/protein-annotation'
import { PROTEOMICS_PDC_TOOLS } from './descriptors/proteomics-pdc'
import { PUBMED_TOOLS } from './descriptors/pubmed'
import { REGULATION_TOOLS } from './descriptors/regulation'
import { RESEARCH_RESOURCES_TOOLS } from './descriptors/research-resources'
import { RNA_TOOLS } from './descriptors/rna'
import { RNA_ENCORI_TOOLS } from './descriptors/rna-encori'
import { SEQUENCE_TOOLS } from './descriptors/sequence-tools'
import { STRUCTURES_TOOLS } from './descriptors/structures'
import { TCIA_TOOLS } from './descriptors/tcia'
import { STRUCTURES_PDBE_TOOLS } from './descriptors/structures-pdbe'
import { VARIANTS_TOOLS } from './descriptors/variants'
import { ZINC_TOOLS } from './descriptors/zinc'
import { ZH_MEDICAL_TERMS_TOOLS } from './descriptors/zh-medical-terms'
import type { CapabilityContract } from '../../shared/capability-contract'
import type { ToolDescriptor } from './types'

const ALL_TOOLS: ToolDescriptor[] = [
  ...BIOMART_TOOLS,
  ...BIORXIV_TOOLS,
  ...CANCER_MODELS_TOOLS,
  ...CELLGUIDE_TOOLS,
  ...RNA_ENCORI_TOOLS,
  ...PROTEOMICS_PDC_TOOLS,
  ...CHEMBL_TOOLS,
  ...CHEMISTRY_TOOLS,
  ...CLINICAL_GENOMICS_TOOLS,
  ...CLINICAL_TRIALS_TOOLS,
  ...DELEGATE_TOOLS,
  ...DRUG_REGULATORY_TOOLS,
  ...EXPRESSION_TOOLS,
  ...GENES_GPROFILER_TOOLS,
  ...GENES_ENRICHR_TOOLS,
  ...GENES_TOOLS,
  ...GENOMES_NCBI_TOOLS,
  ...GENOMES_TOOLS,
  ...HUMAN_GENETICS_TOOLS,
  ...IMMUNE_EPITOPES_TOOLS,
  ...LIPID_MAPS_TOOLS,
  ...LITERATURE_TOOLS,
  ...MOLECULE_TOOLS,
  ...OMICS_ARCHIVES_TOOLS,
  ...OMNIPATH_TOOLS,
  ...OMICS_ENA_TOOLS,
  ...PROTEIN_ANNOTATION_TOOLS,
  ...PUBMED_TOOLS,
  ...REGULATION_TOOLS,
  ...RESEARCH_RESOURCES_TOOLS,
  ...RNA_TOOLS,
  ...SEQUENCE_TOOLS,
  ...STRUCTURES_TOOLS,
  ...STRUCTURES_PDBE_TOOLS,
  ...TCIA_TOOLS,
  ...VARIANTS_TOOLS,
  ...ZINC_TOOLS,
  ...ZH_MEDICAL_TERMS_TOOLS
]

export const ALL_CONNECTOR_IDS = [...new Set(ALL_TOOLS.map((t) => t.connector))]

/**
 * Tools per connector id. The Settings panel states "N connectors · M tools" and needs this number from the
 * registry rather than from a second hand-kept list: a count that lives beside the catalog would drift the
 * first time a tool is added.
 */
export const CONNECTOR_TOOL_COUNTS: Record<string, number> = ALL_TOOLS.reduce<
  Record<string, number>
>((counts, tool) => {
  counts[tool.connector] = (counts[tool.connector] ?? 0) + 1
  return counts
}, {})

/**
 * Connector-declared contracts, for the capability registry. Connector tools are where most facts are
 * actually established, so without these the preflight could name a missing `evidence:literature_set`
 * and no producer even though two tools can make one.
 */
export function allConnectorContracts(): CapabilityContract[] {
  return ALL_TOOLS.flatMap((tool) => (tool.contract ? [tool.contract] : []))
}

export function getConnectorTools(connector: string): ToolDescriptor[] {
  return ALL_TOOLS.filter((t) => t.connector === connector)
}

export function getDescriptor(connector: string, method: string): ToolDescriptor | undefined {
  return ALL_TOOLS.find((t) => t.connector === connector && t.id === method)
}
