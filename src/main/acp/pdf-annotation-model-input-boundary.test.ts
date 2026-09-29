import type { ContentBlock } from '@agentclientprotocol/sdk'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FIXTURE_AREA_COMMENT,
  FIXTURE_HIGHLIGHT_COMMENT,
  FIXTURE_LINES,
  FIXTURE_NOTE_TEXT,
  annotatedPdfFixture
} from '../../../test/fixtures/pdf-annotation-fixtures'
import { createInMemoryPdfAnnotationStore } from '../../../test/fixtures/in-memory-pdf-annotation-client'
import { pdfAnnotationQuote } from '../../shared/pdf-annotation-citation'
import type { Reference } from '../../shared/references'
import { DEFAULT_UPLOAD_PROJECT_NAME } from '../../shared/uploads'
import { createSearchAnnotationCorpus } from '../search/annotation-corpus'
import { PdfAnnotationRepository } from '../references/pdf-annotation-repository'
import { readPdfEmbeddedAnnotations } from '../references/pdf-embedded-annotation-reader'
import { assembleScreeningEvidence } from '../references/screening-evidence'
import { assembleScreeningPrompt } from '../references/screening-prompt'
import { extractPdfText } from '../uploads/attachment-media'
import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import { createManagedFileReferenceResolver } from './file-reference-resolver'
import { AcpPromptContentOwner } from './prompt-content-owner'

// 红线：标注不进模型上下文（文档标注层 A5, 需求 3）.
//
// The plan's fifth red line is that NO input assembly that reaches a model may contain an annotation's
// text — neither the reader's own note nor the passage the markup quotes. A statement in a document is not
// enforcement, so this suite PINS THE TWO PATHS THAT ACTUALLY BUILD MODEL INPUT and proves, on each of
// them, that the text is absent and that the file it is absent from really does contain it:
//
//   PATH 1 — an interactive turn. `AcpPromptContentOwner.prepare` is what turns a turn's attachments into
//            the content blocks the agent receives; a PDF attachment becomes text through
//            `extractPdfText` (uploads/attachment-media.ts) and nothing else.
//   PATH 2 — literature screening. `assembleScreeningEvidence` decides which text the screening model is
//            shown, and `assembleScreeningPrompt` renders it into the prompt that is sent.
//
// The differential is what makes the assertion mean something: the same PDF is put through A2's own
// annotation reader first, which proves the annotation bodies ARE in the file's bytes and reads them out
// verbatim. If the model input still contains none of them, the exclusion is real rather than a fixture
// that simply had nothing to exclude. And a third check closes the other side: the SAME texts are found by
// the search corpus's reader, so this is an annotation the application genuinely holds — it is excluded
// from the model's input, not absent from the application.

const roots: string[] = []

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-annotation-model-boundary-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Every text a model could read out of one prepared turn: text blocks and inline text resources. */
const modelInputText = (content: string | ContentBlock[]): string => {
  if (typeof content === 'string') return content
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'resource' && 'text' in block.resource) return block.resource.text
      if (block.type === 'resource_link') return block.name ?? ''
      return ''
    })
    .join('\n')
}

// Every annotation body the fixture PDF carries, as A2 reads them out of the file's own bytes. Named here
// because each of them is asserted ABSENT from every model input below.
const ANNOTATION_TEXTS_IN_FIXTURE = [
  FIXTURE_HIGHLIGHT_COMMENT,
  FIXTURE_AREA_COMMENT,
  FIXTURE_NOTE_TEXT
] as const

const reference = (): Reference => ({
  id: 'ref-1',
  projectId: 'project-1',
  title: 'A randomized trial of something',
  authors: [{ name: 'Ada Lovelace' }],
  venue: 'Journal of Tests',
  year: 2024,
  doi: '10.1000/xyz',
  pmid: undefined,
  pmcid: undefined,
  arxivId: undefined,
  url: undefined,
  abstractSnippet: 'Short abstract.',
  sourceConnector: 'manual',
  sourceRecordId: undefined,
  citationKey: 'Lovelace2024',
  provenance: undefined,
  pdfManagedFileId: undefined,
  notes: undefined,
  createdAt: 1,
  updatedAt: 1
})

describe('the annotated fixture really does carry annotations', () => {
  it('reads every annotation body out of the file with the A2 reader', async () => {
    const parsed = await readPdfEmbeddedAnnotations(annotatedPdfFixture())
    const bodies = parsed.annotations.map((annotation) => annotation.contents)

    // The premise of every assertion below: these strings are IN the file, read from its own bytes by the
    // same parser the import channel uses. Without this the "absent from the model input" checks would be
    // satisfied by a fixture that carried nothing to leak.
    for (const text of ANNOTATION_TEXTS_IN_FIXTURE) {
      expect(bodies, text).toContain(text)
    }
  })
})

describe('PATH 1 — the interactive turn does not carry annotation text to the model', () => {
  it('sends the PDF text layer and none of the markup, on the real attachment path', async () => {
    const root = await createRoot()
    const repository = new UploadRepository(root)
    const bytes = annotatedPdfFixture()
    const [attachment] = await stageUploadFixtures(repository, {
      files: [
        {
          name: 'annotated.pdf',
          content: Buffer.from(bytes).toString('base64'),
          mimeType: 'application/pdf'
        }
      ]
    })

    const owner = new AcpPromptContentOwner({
      uploadRepository: repository,
      fileReferenceResolver: createManagedFileReferenceResolver({})
    })
    const prepared = await owner.prepare({
      appSessionId: 'session-boundary',
      // The project the fixture uploads were staged under: the resolver refuses an upload addressed from
      // another project, which is what keeps this path the same one production uses.
      projectId: DEFAULT_UPLOAD_PROJECT_NAME,
      text: 'What does this paper claim?',
      historyImages: [],
      historyUploads: [],
      currentUploads: [attachment!],
      references: [],
      annotations: [],
      codexSkillInputs: [],
      skillImportEnabled: false,
      skillImportTurnToken: undefined,
      onSkillImportAttachmentEligible: vi.fn()
    })

    const sent = modelInputText(prepared.content)
    // The file's own text layer IS what the model gets — the path is not simply dropping the PDF, which
    // would make the exclusion below true for the wrong reason.
    expect(sent).toContain(FIXTURE_LINES.highlighted.text)
    expect(sent).toContain(FIXTURE_LINES.secondPage.text)
    // …and not one character of the markup's own text travels with it.
    for (const text of ANNOTATION_TEXTS_IN_FIXTURE) {
      expect(sent, text).not.toContain(text)
    }
  })

  it('extracts no annotation text at all, even though the parser sees the annotation dictionaries', async () => {
    const root = await createRoot()
    const path = join(root, 'annotated.pdf')
    await writeFile(path, annotatedPdfFixture())

    const extracted = await extractPdfText(path)
    expect(extracted.text).toContain(FIXTURE_LINES.highlighted.text)
    for (const text of ANNOTATION_TEXTS_IN_FIXTURE) {
      expect(extracted.text, text).not.toContain(text)
    }
    // A highlight over blank space carries a comment too; it is in the file and still not in the text.
    expect(extracted.text).not.toContain('over blank space')
    expect(extracted.text).not.toContain('hidden from every viewer')
  })
})

describe('PATH 2 — the screening prompt does not carry annotation text to the model', () => {
  it('builds the model prompt from the record and its extracted text, with no markup in either zone', async () => {
    const root = await createRoot()
    const path = join(root, 'annotated.pdf')
    await writeFile(path, annotatedPdfFixture())
    // The same extractor PATH 1 uses: the screening path gets its full text the way the attachment
    // pipeline does, so the exclusion follows the text rather than a second, luckier reader.
    const extracted = await extractPdfText(path)

    const evidence = assembleScreeningEvidence({
      reference: reference(),
      fullText: extracted.text
    })
    const assembled = assembleScreeningPrompt({
      inclusion: [{ id: 'i1', text: 'Randomized trial' }],
      exclusion: [{ id: 'e1', text: 'Not in humans' }],
      coverage: evidence.coverage,
      sections: evidence.sections
    })

    expect(assembled.prompt).toContain(extracted.text.slice(0, 40))
    expect(assembled.prompt).toContain('A randomized trial of something')
    for (const text of ANNOTATION_TEXTS_IN_FIXTURE) {
      expect(assembled.prompt, text).not.toContain(text)
      expect(assembled.instructionZone, text).not.toContain(text)
      expect(assembled.dataZone, text).not.toContain(text)
    }
  })
})

describe('the same annotation text IS held by the application — it just never reaches a model', () => {
  it('finds the annotation text through the search corpus, which reads stored rows and no PDF', async () => {
    const store = createInMemoryPdfAnnotationStore()
    const repository = new PdfAnnotationRepository(() => Promise.resolve(store.client))
    const sourceFileId = 'artifact-1'
    const versionId = 'version-1'

    // A stored annotation exactly as the panel would write it: the quote is the passage the markup covers,
    // the body is the reader's note. Both are the texts the search corpus indexes.
    await repository.createAnnotation({
      sourceFileId,
      versionId,
      checksum: 'a'.repeat(64),
      kind: 'highlight',
      selector: {
        version: 1,
        shape: 'text-range',
        page: 1,
        rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.03 }],
        quote: FIXTURE_LINES.highlighted.text
      },
      body: FIXTURE_HIGHLIGHT_COMMENT
    })

    const corpus = createSearchAnnotationCorpus({
      listAnchors: async () => ({
        anchors: [{ sourceFileId, versionId, fileName: 'annotated.pdf' }]
      }),
      readAnnotations: async ({ anchors, limit }) =>
        repository.listAnnotationsForFileVersions(anchors, { limit })
    })
    const read = await corpus.list({ projectId: 'project-1' })

    expect(read.annotations).toHaveLength(1)
    // Both indexed fields are the STORED text: what the reader typed, and what the file said when it was
    // marked. Neither is derived from reading the PDF back.
    expect(read.annotations[0]!.body).toBe(FIXTURE_HIGHLIGHT_COMMENT)
    expect(read.annotations[0]!.quote).toBe(FIXTURE_LINES.highlighted.text)
    expect(pdfAnnotationQuote({ version: 1, shape: 'document-note' })).toBe('')

    // The very strings asserted absent from every model input above are present here. So the red line
    // holds because the annotation was kept OUT of the model's input, not because the application lost it.
    const searchable = read.annotations
      .map((annotation) => `${annotation.body}\n${annotation.quote}`)
      .join('\n')
    expect(searchable).toContain(FIXTURE_HIGHLIGHT_COMMENT)
  })
})
