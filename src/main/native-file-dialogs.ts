import type { MessageBoxOptions, OpenDialogOptions, SaveDialogOptions } from 'electron'

import { FILE_DIALOG_STRINGS, type FileDialogStrings } from './native-dialog-strings'
import { resolveNativeLocaleCode, type NativeLocaleCode } from './native-locale'
import { SESSION_PACKAGE_EXTENSION } from '../shared/session-package'
import { PDF_ANNOTATION_EXPORT_CHANNELS } from '../shared/pdf-annotation-export'

// The OS file panels main opens itself. Each builder is exported and takes the language code
// explicitly (defaulting to the OS cascade) for the same reason `migrationQuitDialogOptions` does:
// a native panel draws itself outside the renderer, so there is no rendered output to diff — the
// only way to prove the wording reached the reader in their language is to build the options for
// each of the nine locales and read them back (see native-file-dialogs.test.ts).
//
// Keeping the builders here, rather than in each of the six modules that open a panel, is what makes
// that sweep possible: the modules hold the windows and the write that follows the panel, not the
// sentence. A call site that picked the wrong field (the artifact title on the file dialog) would
// still compile and still look translated, so the field choice has to be asserted somewhere — and
// that somewhere is one table of nine rows per panel.
const stringsFor = (code?: NativeLocaleCode): FileDialogStrings =>
  FILE_DIALOG_STRINGS[code ?? resolveNativeLocaleCode()]

// The extension stays the one shared constant; the panels only carry it without its leading dot.
const packageExtension = (): string => SESSION_PACKAGE_EXTENSION.slice(1)

const configFilter = (strings: FileDialogStrings): { name: string; extensions: string[] } => ({
  name: strings.connectorFilter,
  extensions: ['json']
})

export const connectorConfigOpenPanelOptions = (code?: NativeLocaleCode): OpenDialogOptions => {
  const strings = stringsFor(code)
  return {
    title: strings.importConnectorTitle,
    properties: ['openFile'],
    filters: [configFilter(strings)]
  }
}

export const connectorConfigSavePanelOptions = (
  defaultPath: string,
  code?: NativeLocaleCode
): SaveDialogOptions => {
  const strings = stringsFor(code)
  return {
    title: strings.exportConnectorTitle,
    defaultPath,
    filters: [configFilter(strings)]
  }
}

export const sessionPackageOpenPanelOptions = (code?: NativeLocaleCode): OpenDialogOptions => {
  const strings = stringsFor(code)
  return {
    title: strings.importSessionPackageTitle,
    filters: [{ name: strings.sessionPackageFilter, extensions: [packageExtension()] }],
    properties: ['openFile']
  }
}

export const sessionPackageSavePanelOptions = (
  defaultPath: string,
  code?: NativeLocaleCode
): SaveDialogOptions => {
  const strings = stringsFor(code)
  return {
    title: strings.exportSessionPackageTitle,
    defaultPath,
    filters: [{ name: strings.sessionPackageFilter, extensions: [packageExtension()] }]
  }
}

export const supportBundleSavePanelOptions = (
  defaultPath: string | undefined,
  code?: NativeLocaleCode
): SaveDialogOptions => {
  const strings = stringsFor(code)
  return {
    title: strings.exportSupportBundleTitle,
    ...(defaultPath ? { defaultPath } : {}),
    filters: [{ name: strings.supportBundleFilter, extensions: ['gz'] }]
  }
}

export const updateInstallerSavePanelOptions = (
  defaultPath: string,
  code?: NativeLocaleCode
): SaveDialogOptions => ({
  defaultPath,
  title: stringsFor(code).saveUpdateInstallerTitle
})

export const managedFileSavePanelOptions = (
  defaultPath: string,
  code?: NativeLocaleCode
): SaveDialogOptions => ({
  defaultPath,
  title: stringsFor(code).saveFileTitle
})

export const sessionArtifactSavePanelOptions = (
  defaultPath: string,
  code?: NativeLocaleCode
): SaveDialogOptions => ({
  defaultPath,
  title: stringsFor(code).saveArtifactTitle
})

export const sessionArtifactFolderPanelOptions = (
  defaultPath: string,
  code?: NativeLocaleCode
): OpenDialogOptions => ({
  defaultPath,
  properties: ['openDirectory', 'createDirectory'],
  title: stringsFor(code).chooseArtifactFolderTitle
})

// The annotation export picks its panel per channel: notes go out as text, the annotated copy keeps
// the PDF filter. `PDF` stays untranslated (a format name), so only the text filter and both titles
// come from the table.
export const annotationSavePanelOptions = (
  channel: (typeof PDF_ANNOTATION_EXPORT_CHANNELS)[number],
  code?: NativeLocaleCode
): { filter: { name: string; extensions: string[] }; title: string } => {
  const strings = stringsFor(code)
  const notes = channel === 'notes'
  return {
    filter: {
      name: notes ? strings.annotationTextFilter : 'PDF',
      extensions: [notes ? 'txt' : 'pdf']
    },
    title: notes ? strings.saveAnnotationNotesTitle : strings.saveAnnotatedCopyTitle
  }
}

export const notebookExportOpenPanelOptions = (
  defaultPath: string,
  code?: NativeLocaleCode
): OpenDialogOptions => ({
  title: stringsFor(code).exportNotebooksTitle,
  defaultPath,
  properties: ['openDirectory', 'createDirectory']
})

export const notebookOverwritePanelOptions = (
  count: number,
  listing: string,
  code?: NativeLocaleCode
): MessageBoxOptions => {
  const strings = stringsFor(code)
  return {
    type: 'question',
    title: strings.overwriteNotebooksTitle,
    message: strings.overwriteNotebooksMessage(count),
    detail: listing,
    buttons: [strings.overwriteButton, strings.cancelButton],
    // Cancelling is the default action: a stray Return must not overwrite the reader's files.
    defaultId: 1,
    cancelId: 1
  }
}
