// Network egress allowlist: which domains the notebook / repl / shell child processes may reach.
// When the master switch is on, child processes are routed through a local filtering proxy that
// only lets through the enabled scientific domain groups plus any custom domains the user added.
// The default (switch off) leaves the current unrestricted behavior unchanged.

// The 6 built-in scientific domain groups, keyed by stable id. Each group carries the concrete
// domains (host or subdomain suffix) that belong to it; matching is suffix-based so a group like
// genomics also covers eutils.ncbi.nlm.nih.gov when included.
export const EGRESS_DOMAIN_GROUPS = [
  {
    id: 'literature',
    label: 'Literature & repositories',
    domains: [
      'arxiv.org',
      'biorxiv.org',
      'europepmc.org',
      'pubmed.ncbi.nlm.nih.gov',
      'eutils.ncbi.nlm.nih.gov',
      'openalex.org',
      'doi.org',
      'orcid.org',
      'crossref.org',
      'semanticscholar.org',
      'pubmedcentral.nih.gov'
    ]
  },
  {
    id: 'genomics',
    label: 'Genomics & variant databases',
    domains: [
      'ncbi.nlm.nih.gov',
      'ensembl.org',
      'genome.ucsc.edu',
      'gnomad.broadinstitute.org',
      'gtexportal.org',
      'mygene.info',
      'clinicalgenome.org',
      'clingen.org',
      'ebi.ac.uk',
      'genome.network'
    ]
  },
  {
    id: 'structures',
    label: 'Structures & chemistry',
    domains: [
      'rcsb.org',
      'alphafold.ebi.ac.uk',
      'bindingdb.org',
      'docking.org',
      'chembl.org',
      'rhea-db.org',
      'uniprot.org',
      'pdbj.org',
      'molport.com',
      'zinc15.docking.org'
    ]
  },
  {
    id: 'clinical',
    label: 'Clinical trials & drug data',
    domains: [
      'clinicaltrials.gov',
      'fda.gov',
      'grants.gov',
      'opentargets.org',
      'civicdb.org',
      'drugbank.com',
      'drugcentral.org',
      'pubchem.ncbi.nlm.nih.gov',
      'pharmgkb.org'
    ]
  },
  {
    id: 'bioinformatics',
    label: 'Bioinformatics tools & databases',
    domains: [
      'cellxgene.cziscience.com',
      'jaspar.elixir.no',
      'rfam.org',
      'purl.obolibrary.org',
      'purl.uniprot.org',
      'geneontology.org',
      'reactome.org',
      'string-db.org',
      'biogrid.org',
      'intact.eu',
      'proteomicsdb.org'
    ]
  },
  {
    id: 'repositories',
    label: 'Code & package repositories',
    domains: [
      'github.com',
      'raw.githubusercontent.com',
      'pypi.org',
      'cran.r-project.org',
      'conda.anaconda.org',
      'repo.anaconda.com',
      'r-universe.dev'
    ]
  }
] as const

export type EgressDomainGroupId = (typeof EGRESS_DOMAIN_GROUPS)[number]['id']

// Persisted egress allowlist settings. `enabled` gates the whole mechanism; disabled groups and
// missing entries fall back to their default (groups default on, so existing behavior stays open
// unless the user explicitly narrows it).
export type EgressSettings = {
  enabled: boolean
  // Group id -> on/off. Absent means on (default-open).
  groups: Partial<Record<EgressDomainGroupId, boolean>>
  // User-added hostnames (suffix-matched, no protocol, no port).
  customDomains: string[]
}

export const DEFAULT_EGRESS_SETTINGS: EgressSettings = {
  enabled: false,
  groups: {},
  customDomains: []
}

// Renders the effective allowlist from settings: enabled groups' domains + custom domains.
// Returns undefined when the mechanism is off (callers keep current behavior).
export const resolveEgressAllowlist = (
  settings: EgressSettings | undefined
): string[] | undefined => {
  if (!settings?.enabled) return undefined
  const domains: string[] = [...settings.customDomains]
  for (const group of EGRESS_DOMAIN_GROUPS) {
    if (settings.groups[group.id] !== false) {
      domains.push(...group.domains)
    }
  }
  return [
    ...new Set(
      domains.map((domain) =>
        domain
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/\/.*$/, '')
      )
    )
  ]
}

// Matches a host against the allowlist (suffix match on domain labels).
export const isHostAllowed = (host: string, allowlist: string[]): boolean => {
  const normalized = host.toLowerCase().replace(/:\d+$/, '')
  return allowlist.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`))
}

// Built-in exfiltration deny list: hosts that are NEVER permitted, regardless of the allowlist
// state. These are the canonical external-exfiltration targets — cloud metadata endpoints that
// leak credentials, and well-known paste/exfil services. The deny list is unconditional: it wins
// over any allowlist entry, and it applies even when the egress mechanism is otherwise off.
export const EGRESS_DENY_DOMAINS: readonly string[] = Object.freeze([
  // Cloud instance-metadata endpoints (credential exfiltration).
  '169.254.169.254',
  'metadata.google.internal',
  '169.254.170.2', // AWS ECS container credentials
  '100.100.100.200' // Alibaba Cloud metadata
])

// True when the host is on the built-in deny list (suffix match, case-insensitive).
export const isHostDenied = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/:\d+$/, '')
  return EGRESS_DENY_DOMAINS.some(
    (denied) => normalized === denied || normalized.endsWith(`.${denied}`)
  )
}
