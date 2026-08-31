import type { ToolDescriptor } from '../types'

// CADD (Combined Annotation Dependent Depletion) — variant deleteriousness scores from the
// Kircher et al. 2014 CADD method, served by the UW CADD web API
// (https://cadd.gs.washington.edu/api/v1.0/<version>/<chrom>:<pos>[_<ref>_<alt>]).
// PHRED-scaled scores rank how deleterious a variant is relative to all possible SNVs; higher is
// more deleterious (≥20 = top 1%, ≥30 = top 0.1%).
// Mirrors the cadd_scores MCP server surface: single-variant score, position score, and version.

const CADD_API = 'https://cadd.gs.washington.edu/api/v1.0'
// Positional coordinate builds map to CADD release versions. Default is GRCh37 v1.6 (widely used
// for clinically-reported positions); callers may pass any CADD version string.
const DEFAULT_VERSION = 'GRCh37-v1.6'
const KNOWN_VERSIONS = [
  'v1.0',
  'v1.1',
  'v1.2',
  'v1.3',
  'GRCh37-v1.4',
  'GRCh38-v1.4',
  'GRCh38-v1.5',
  'GRCh37-v1.6',
  'GRCh38-v1.6',
  'GRCh37-v1.7',
  'GRCh38-v1.7'
] as const

// The API returns a JSON array of SNV objects with string-typed numeric fields.
type CaddScoresResponse = Array<{
  Alt: string
  Chrom: string
  PHRED: string
  Pos: string
  RawScore: string
  Ref: string
}>

const assertPosInt = (value: unknown, label: string): number => {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer`)
  return n
}

const assertChrom = (value: unknown): string => {
  const chrom = String(value ?? '').trim()
  if (!/^([1-9]|1[0-9]|2[0-2]|X|Y|MT)$/i.test(chrom)) {
    throw new Error(`invalid chromosome: ${chrom}`)
  }
  return chrom
}

const assertAllele = (value: unknown, label: string): string => {
  const base = String(value ?? '')
    .trim()
    .toUpperCase()
  if (!/^[ACGTN]+$/.test(base)) throw new Error(`${label} must be a DNA allele (A/C/G/T/N)`)
  return base
}

const assertVersion = (value: unknown): string => {
  const version = String(value ?? DEFAULT_VERSION).trim()
  if (!(KNOWN_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(`unknown CADD version: ${version} (known: ${KNOWN_VERSIONS.join(', ')})`)
  }
  return version
}

// Maps one API row to the agent-facing shape with a plain-language severity band.
const scoreRow = (row: {
  Alt: string
  Chrom: string
  PHRED: string
  Pos: string
  RawScore: string
  Ref: string
}): Record<string, unknown> => {
  const phr = Number.parseFloat(row.PHRED)
  const band =
    phr >= 30
      ? 'high (top 0.1% deleterious)'
      : phr >= 20
        ? 'medium-high (top 1%)'
        : phr >= 10
          ? 'medium (top 10%)'
          : 'low'
  return {
    variant_id: `${row.Chrom}:${row.Pos}:${row.Ref}:${row.Alt}`,
    chrom: row.Chrom,
    pos: Number(row.Pos),
    ref: row.Ref,
    alt: row.Alt,
    phred_score: phr,
    raw_score: Number.parseFloat(row.RawScore),
    severity_band: band
  }
}

export const VARIANTS_CADD_TOOLS: ToolDescriptor[] = [
  {
    id: 'cadd_score_variant',
    connector: 'variants',
    description:
      'Get the CADD deleteriousness score (PHRED + raw) for a single SNV. CADD ranks how ' +
      'deleterious a variant is relative to all possible SNVs: PHRED ≥20 means top 1%, ≥30 means ' +
      'top 0.1%. Positions are GRCh37 by default (use version to switch builds).',
    input: {
      type: 'object',
      properties: {
        chrom: { type: 'string', description: 'Chromosome: 1-22, X, Y, or MT.' },
        pos: { type: 'integer', description: '1-based genomic position (GRCh37 by default).' },
        ref: { type: 'string', description: 'Reference allele (A/C/G/T).' },
        alt: { type: 'string', description: 'Alternate allele (A/C/G/T).' },
        version: {
          type: 'string',
          default: DEFAULT_VERSION,
          description: 'CADD release, e.g. GRCh37-v1.6, GRCh38-v1.7'
        }
      },
      required: ['chrom', 'pos', 'ref', 'alt']
    },
    returns:
      '`{ variant_id, chrom, pos, ref, alt, phred_score, raw_score, severity_band }`. Returns `{ found: false }` when the version/build has no score for the allele.',
    example:
      'const result = await host.mcp("variants", "cadd_score_variant", {"chrom": "7", "pos": 55249071, "ref": "C", "alt": "T"})',
    run: async (ctx, args) => {
      const chrom = assertChrom(args.chrom)
      const pos = assertPosInt(args.pos, 'pos')
      const ref = assertAllele(args.ref, 'ref')
      const alt = assertAllele(args.alt, 'alt')
      const version = assertVersion(args.version)
      const url = `${CADD_API}/${version}/${chrom}:${pos}_${ref}_${alt}`
      const rows = (await ctx.fetchJson(url)) as CaddScoresResponse
      if (!Array.isArray(rows) || rows.length === 0) {
        return { variant_id: `${chrom}:${pos}:${ref}:${alt}`, found: false }
      }
      return scoreRow(rows[0]!)
    }
  },
  {
    id: 'cadd_score_at_position',
    connector: 'variants',
    description:
      'Get CADD scores for all three SNVs at a genomic position (ref→A/C/G alternatives). ' +
      'Positions are GRCh37 by default.',
    input: {
      type: 'object',
      properties: {
        chrom: { type: 'string', description: 'Chromosome: 1-22, X, Y, or MT.' },
        pos: { type: 'integer', description: '1-based genomic position (GRCh37 by default).' },
        version: {
          type: 'string',
          default: DEFAULT_VERSION,
          description: 'CADD release, e.g. GRCh37-v1.6, GRCh38-v1.7'
        }
      },
      required: ['chrom', 'pos']
    },
    returns:
      '`{ chrom, pos, version, count, scores: [ { variant_id, ref, alt, phred_score, raw_score, severity_band } ] }`.',
    example:
      'const result = await host.mcp("variants", "cadd_score_at_position", {"chrom": "7", "pos": 55249071})',
    run: async (ctx, args) => {
      const chrom = assertChrom(args.chrom)
      const pos = assertPosInt(args.pos, 'pos')
      const version = assertVersion(args.version)
      const url = `${CADD_API}/${version}/${chrom}:${pos}`
      const rows = (await ctx.fetchJson(url)) as CaddScoresResponse
      const scores = Array.isArray(rows) ? rows.map(scoreRow) : []
      return { chrom, pos, version, count: scores.length, scores }
    }
  }
]
