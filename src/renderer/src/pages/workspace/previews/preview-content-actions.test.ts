import { describe, expect, it, vi } from 'vitest'

import { buildPreviewContentActions } from './preview-content-actions'

// U16: what a preview can DO is decided here, once, and both the right-click menu and the header toolbar
// render the result. These tests pin the media gating and the capability rules, so neither surface can
// start offering a different set than the other.

const handlers = (): Parameters<typeof buildPreviewContentActions>[1] => ({
  copyPath: vi.fn(),
  download: vi.fn(),
  saveAsArtifact: vi.fn(),
  digitizeFigure: vi.fn(),
  omicsPreview: vi.fn(),
  pdfReferenceImport: vi.fn(),
  pdfTables: vi.fn()
})

const ids = (
  name: string,
  overrides: Partial<Parameters<typeof buildPreviewContentActions>[1]> = {}
): string[] =>
  buildPreviewContentActions(name, { ...handlers(), ...overrides }).map((action) => action.id)

describe('preview content actions', () => {
  it('always offers the file trio, in one fixed order', () => {
    expect(ids('notes.txt')).toEqual(['copyPath', 'download', 'saveAsArtifact'])
  })

  it('offers figure digitization for images and PDFs, and the PDF-only actions for PDFs', () => {
    expect(ids('figure.png')).toEqual(['copyPath', 'download', 'saveAsArtifact', 'digitizeFigure'])
    expect(ids('paper.PDF')).toEqual([
      'copyPath',
      'download',
      'saveAsArtifact',
      'digitizeFigure',
      'pdfReferenceImport',
      'pdfTables'
    ])
  })

  it('offers the omics preview only for the large omics media', () => {
    expect(ids('cells.h5ad')).toContain('omicsPreview')
    expect(ids('variants.vcf.gz')).toContain('omicsPreview')
    expect(ids('figure.png')).not.toContain('omicsPreview')
    expect(ids('paper.pdf')).not.toContain('omicsPreview')
  })

  it('drops an action whose capability the surface was not given', () => {
    expect(ids('paper.pdf', { pdfTables: undefined })).not.toContain('pdfTables')
    expect(ids('paper.pdf', { pdfReferenceImport: undefined })).not.toContain('pdfReferenceImport')
    // A missing capability must not leak the action onto media the capability would not apply to either.
    expect(ids('notes.txt', { digitizeFigure: undefined })).not.toContain('digitizeFigure')
  })

  it('runs the handler it was given, once per action', () => {
    const spies = handlers()
    const actions = buildPreviewContentActions('paper.pdf', spies)
    for (const action of actions) action.run()

    expect(spies.copyPath).toHaveBeenCalledTimes(1)
    expect(spies.download).toHaveBeenCalledTimes(1)
    expect(spies.saveAsArtifact).toHaveBeenCalledTimes(1)
    expect(spies.digitizeFigure).toHaveBeenCalledTimes(1)
    expect(spies.pdfReferenceImport).toHaveBeenCalledTimes(1)
    expect(spies.pdfTables).toHaveBeenCalledTimes(1)
    expect(spies.omicsPreview).not.toHaveBeenCalled()
  })

  it('carries the test id and label key each surface renders', () => {
    const [first] = buildPreviewContentActions('notes.txt', handlers())
    expect(first.testId).toBe('preview-copy-path')
    expect(first.labelKey).toBe('ws.previewTabCopyPath')
  })
})
