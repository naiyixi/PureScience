// The gallery's content, kept as data: one entry per capability this product has actually run on a real
// machine. Two things make it a gallery of evidence rather than a wall of screenshots:
//
//  1. `readings` and `quotes` hold **raw strings copied out of an evidence file** — not paraphrases.
//     `use-case-gallery.test.ts` re-reads every file named in `evidence` and fails if a string is not
//     there, so a card cannot drift away from the reading it claims (and a plausible-looking number
//     cannot be invented).
//  2. `command` is the rerun path. The test resolves every path it mentions on disk, so "how to verify"
//     never points at a file that stopped existing.
//
// Titles, claims and judgments are interface copy and live in the i18n dictionaries (three keys per
// sample, `gallery.sample.<id>.*`); what lives here is language-neutral: identifiers, measured values,
// the agent's or the log's own words, and file paths.

import type { TranslationKey } from '@/i18n'

type UseCaseReading = {
  /** The thing that was measured. A field name, endpoint or command — never a translated sentence. */
  label: string
  /** The measured value, verbatim from the evidence file (the guard test checks this). */
  value: string
}

type UseCaseQuote = {
  /** Words the product or its log actually produced, verbatim from the evidence file. */
  text: string
  /** Where those words came from, so the reader knows whose voice this is. */
  origin: string
}

/** The closed set of sample ids. A literal union so a mistyped id is a compile error, not a missing
 *  translation that silently renders the key. */
type SampleId =
  'external-mcp' | 'citation-discovery' | 'session-package' | 'long-session' | 'docx-fidelity'

type UseCaseSample = {
  /** Stable id; also the DOM slot suffix and the i18n key segment. */
  id: SampleId
  /** Evidence files this card is built from. Every reading/quote must appear in one of them. */
  evidence: string[]
  /** How to rerun it. Paths inside it must exist on disk. */
  command: string
  readings: UseCaseReading[]
  quotes: UseCaseQuote[]
}

const USE_CASE_SAMPLES: UseCaseSample[] = [
  {
    id: 'external-mcp',
    evidence: ['docs/evidence/2026-10-30-f1-external-mcp.md'],
    command: 'npx playwright test e2e/certification/external-mcp-client.spec.ts --workers=1',
    readings: [
      {
        label: 'tools/list',
        value: '["list_project_files","list_projects","list_sessions","read_session"]'
      },
      { label: 'spec', value: '1 passed (7.8s)' },
      { label: 'read_session(no-such-session)', value: 'session-not-found' },
      { label: 'audit rows in one run', value: 'external mcp call' }
    ],
    quotes: [
      {
        text: "external MCP server started { transport: 'tcp', host: '127.0.0.1', port: 63607, tools: 4 }",
        origin: 'main.log'
      },
      {
        text: 'Call list_sessions for the ids this machine holds.',
        origin: 'refusal message returned to the client'
      }
    ]
  },
  {
    id: 'citation-discovery',
    evidence: ['docs/evidence/2026-10-29-b2-citation-discovery.md'],
    command: 'npx vitest run src/main/references/citation-discovery.test.ts',
    readings: [
      { label: 'citations: total → examined', value: '83,700' },
      { label: 'examined per walk', value: 'examined=50' },
      { label: '200-row sample, publisher-country hits', value: '194' },
      { label: 'signal that carries the claim', value: 'doi-prefix' }
    ],
    quotes: [
      {
        text: 'this work lists 53 references; the walk reads the first 50',
        origin: 'error text shown on the partial-read badge'
      }
    ]
  },
  {
    id: 'session-package',
    evidence: [
      'docs/evidence/2026-10-29-d1-session-package-transport.md',
      'docs/evidence/2026-10-29-d2-package-readings-recompute.md'
    ],
    command:
      'npx playwright test e2e/certification/session-package-three-surfaces.spec.ts --workers=1',
    readings: [
      { label: 'payload sha256 (desktop / Web / CLI)', value: 'd36518b53a7d' },
      { label: 'CLI export', value: '326 ms' },
      { label: 'CLI import', value: '233 ms' },
      { label: 'manifest.usage verdict', value: '"state": "match"' }
    ],
    quotes: [
      {
        text: "posture` = `{ readOnly: true, executeAllowed: false, verificationLabel: 'source-party' }",
        origin: 'import result (CLI --json)'
      }
    ]
  },
  {
    id: 'long-session',
    evidence: ['docs/evidence/2026-10-29-e1-e2-long-session-readings.md'],
    command: 'npx playwright test e2e/certification/session-turn-readings-real-window.spec.ts',
    readings: [
      { label: 'spec', value: '1 passed (11.8 s)' },
      { label: 'group summary row', value: '2 steps' },
      { label: 'cost cell when nothing was reported', value: 'usage not recorded' }
    ],
    quotes: [
      {
        text: '[e1-e2] summary row: Fetched 2 pages · 2 steps · 1ms · usage not recorded',
        origin: 'spec console output, real window'
      }
    ]
  },
  {
    id: 'docx-fidelity',
    evidence: ['docs/evidence/2026-10-30-h2-docx-table-fidelity.md'],
    command: 'npx playwright test e2e/certification/office-preview-docx-tables.spec.ts --workers=1',
    readings: [
      { label: 'real-window spec', value: '1 passed (7.0s)' },
      { label: 'unit suite (real docx bytes)', value: '9 passed' },
      { label: 'preview family', value: '43 files / 353 passed' },
      { label: 'table 1 frame, top edge', value: '3.21 px' },
      { label: 'table 1 inner grid', value: '0.80 px' }
    ],
    quotes: [
      {
        text: '[office-preview] docx table borders reconciled',
        origin: 'console.info from the reconciliation step'
      }
    ]
  }
]

const USE_CASE_SAMPLE_IDS = USE_CASE_SAMPLES.map((sample) => sample.id)

/** i18n key for one sample's title / claim / judgment. Typed as a dictionary key: adding a sample
 *  without its three translations is a type error, not a screen full of raw keys. */
const sampleKey = (id: SampleId, field: 'title' | 'claim' | 'judgment'): TranslationKey =>
  `gallery.sample.${id}.${field}`

export { USE_CASE_SAMPLES, USE_CASE_SAMPLE_IDS, sampleKey }
export type { SampleId, UseCaseQuote, UseCaseReading, UseCaseSample }
