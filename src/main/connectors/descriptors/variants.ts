import type { ToolDescriptor } from '../types'
import { VARIANTS_GNOMAD_TOOLS } from './variants-gnomad'
import { VARIANTS_CLINVAR_TOOLS } from './variants-clinvar'
import { VARIANTS_DBSNP_TOOLS } from './variants-dbsnp'
import { VARIANTS_CADD_TOOLS } from './variants-cadd'

// "Variants" connector: human genetic variants across gnomAD (population frequencies, constraint,
// structural and mitochondrial variants, liftover), ClinVar (direct NCBI records/search), dbSNP,
// and CADD (deleteriousness scores). Tools are split across descriptor files by source; this
// module aggregates them in the connector's display order.
export const VARIANTS_TOOLS: ToolDescriptor[] = [
  ...VARIANTS_GNOMAD_TOOLS,
  ...VARIANTS_CLINVAR_TOOLS,
  ...VARIANTS_DBSNP_TOOLS,
  ...VARIANTS_CADD_TOOLS
]
