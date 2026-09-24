import { BookMarked, ClipboardCopy, Crosshair, Dna, Download, FileUp, Table } from 'lucide-react'

import type { TranslationKey } from '@/i18n'

// Which media a preview action applies to. Kept next to the action list so the right-click menu and the
// toolbar cannot disagree about what a given file offers.
export const DIGITIZABLE_MEDIA = /\.(png|jpe?g|webp|tiff?|pdf)$/i
// Large omics files: the preview never invents counts, it loads a manifest produced read-only.
export const OMICS_DATA_MEDIA = /\.(h5ad|vcf|vcf\.gz|vcf\.bgz)$/i
// Table candidates come from the PDF's own text layer, so any PDF the app can register qualifies.
export const PDF_TABLE_MEDIA = /\.pdf$/i

export type PreviewContentActionId =
  | 'copyPath'
  | 'download'
  | 'saveAsArtifact'
  | 'digitizeFigure'
  | 'omicsPreview'
  | 'pdfReferenceImport'
  | 'pdfTables'

export type PreviewContentAction = {
  id: PreviewContentActionId
  labelKey: TranslationKey
  testId: string
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: 'true' | 'false' }>
  run: () => void
}

export type PreviewContentActionHandlers = {
  copyPath: () => void
  download: () => void
  saveAsArtifact: () => void
  /** Absent when the surface was mounted without that capability; the action is then not offered at all. */
  digitizeFigure?: () => void
  omicsPreview?: () => void
  pdfReferenceImport?: () => void
  pdfTables?: () => void
}

// The single ordered source of what a preview can DO: the right-click menu and the toolbar both render this
// list, so an action can never be reachable in one place and missing from the other. Media gating lives here
// rather than in either renderer.
export const buildPreviewContentActions = (
  name: string,
  handlers: PreviewContentActionHandlers
): PreviewContentAction[] => {
  const actions: PreviewContentAction[] = [
    {
      id: 'copyPath',
      labelKey: 'ws.previewTabCopyPath',
      testId: 'preview-copy-path',
      Icon: ClipboardCopy,
      run: handlers.copyPath
    },
    {
      id: 'download',
      labelKey: 'ws.previewTabDownload',
      testId: 'preview-download',
      Icon: Download,
      run: handlers.download
    },
    {
      id: 'saveAsArtifact',
      labelKey: 'ws.previewTabSaveAsArtifact',
      testId: 'preview-save-as-artifact',
      Icon: FileUp,
      run: handlers.saveAsArtifact
    }
  ]

  if (handlers.digitizeFigure && DIGITIZABLE_MEDIA.test(name)) {
    actions.push({
      id: 'digitizeFigure',
      labelKey: 'ws.previewTabDigitizeFigure',
      testId: 'preview-digitize-figure',
      Icon: Crosshair,
      run: handlers.digitizeFigure
    })
  }
  if (handlers.omicsPreview && OMICS_DATA_MEDIA.test(name)) {
    actions.push({
      id: 'omicsPreview',
      labelKey: 'ws.previewTabOmicsPreview',
      testId: 'preview-omics-preview',
      Icon: Dna,
      run: handlers.omicsPreview
    })
  }
  if (handlers.pdfReferenceImport && PDF_TABLE_MEDIA.test(name)) {
    actions.push({
      id: 'pdfReferenceImport',
      labelKey: 'references.importFromPdf.menu',
      testId: 'preview-pdf-reference-import',
      Icon: BookMarked,
      run: handlers.pdfReferenceImport
    })
  }
  if (handlers.pdfTables && PDF_TABLE_MEDIA.test(name)) {
    actions.push({
      id: 'pdfTables',
      labelKey: 'pdf.table.menu',
      testId: 'preview-pdf-tables',
      Icon: Table,
      run: handlers.pdfTables
    })
  }

  return actions
}
