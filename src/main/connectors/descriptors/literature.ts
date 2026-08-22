import type { ToolDescriptor } from '../types'
import { OPENALEX_LITERATURE_TOOLS } from './literature-openalex'
import { ARXIV_LITERATURE_TOOLS } from './literature-arxiv'
import { LITERATURE_REVIEW_TOOLS } from './literature-review'

// "Literature Graph" connector: the OpenAlex scholarly graph (works/authors/venues/citations)
// plus arXiv preprint metadata. The tool set is split across two descriptor files by source API
// (OpenAlex REST vs arXiv Atom); this module is the single aggregate the registry imports. The
// multi-source parallel review tool is registered alongside the per-source tools.
export const LITERATURE_TOOLS: ToolDescriptor[] = [
  ...OPENALEX_LITERATURE_TOOLS,
  ...ARXIV_LITERATURE_TOOLS,
  ...LITERATURE_REVIEW_TOOLS
]
