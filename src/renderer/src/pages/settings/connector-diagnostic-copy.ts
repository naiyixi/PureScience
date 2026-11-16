import type { ConnectorTemplateDiagnostic } from '../../../../shared/settings'
import type { TranslationKey } from '@/i18n'

// Connector-configuration diagnostics are produced by the main process, which has no dictionary: it
// composes a canonical English sentence per code (that sentence is what the log and the parser's own
// tests carry). The panel that shows them is rendered here, in the reader's language, so the sentence
// is assembled from the code plus the values the parser attached — never by parsing the English text.
//
// A code this table does not know returns `undefined`, and the caller falls back to the canonical
// English sentence. That is the honest direction: an unknown code shows English rather than a sentence
// with missing words in it.

export type ConnectorDiagnosticCopy = {
  key: TranslationKey
  values: Record<string, string>
}

const copy = (
  key: TranslationKey,
  values: Record<string, string | number>
): ConnectorDiagnosticCopy => ({
  key,
  values: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)]))
})

/** Sentences that name the offending field all need `path`; without it the message is the fallback. */
const withPath = (
  key: TranslationKey,
  diagnostic: ConnectorTemplateDiagnostic
): ConnectorDiagnosticCopy | undefined =>
  diagnostic.path ? copy(key, { path: diagnostic.path }) : undefined

const withPathAndMax = (
  key: TranslationKey,
  diagnostic: ConnectorTemplateDiagnostic
): ConnectorDiagnosticCopy | undefined => {
  const max = diagnostic.params?.max
  return diagnostic.path && max !== undefined
    ? copy(key, { path: diagnostic.path, max })
    : undefined
}

const withValue = (
  key: TranslationKey,
  diagnostic: ConnectorTemplateDiagnostic
): ConnectorDiagnosticCopy | undefined => {
  const value = diagnostic.params?.value
  return value === undefined ? undefined : copy(key, { value })
}

export const connectorDiagnosticCopy = (
  diagnostic: ConnectorTemplateDiagnostic
): ConnectorDiagnosticCopy | undefined => {
  switch (diagnostic.code) {
    case 'connector-template.required':
      return withPath('connectorImport.diag.required', diagnostic)
    case 'connector-template.type': {
      const expected = diagnostic.params?.expected
      const key: TranslationKey =
        expected === 'array'
          ? 'connectorImport.diag.typeArray'
          : expected === 'object'
            ? 'connectorImport.diag.typeObject'
            : 'connectorImport.diag.typeString'
      return withPath(key, diagnostic)
    }
    case 'connector-template.empty':
      return withPath('connectorImport.diag.empty', diagnostic)
    case 'connector-template.too-long':
      return withPathAndMax('connectorImport.diag.tooLong', diagnostic)
    case 'connector-template.too-many':
      return withPathAndMax('connectorImport.diag.tooMany', diagnostic)
    case 'connector-template.too-large':
      return copy('connectorImport.diag.tooLarge', {})
    case 'connector-template.invalid-name':
      return withPath('connectorImport.diag.invalidName', diagnostic)
    case 'connector-template.unknown-field': {
      const field = diagnostic.params?.field
      return field === undefined ? undefined : copy('connectorImport.diag.unknownField', { field })
    }
    case 'connector-template.invalid-json':
      return copy('connectorImport.diag.invalidJson', {})
    case 'connector-template.root':
      return copy('connectorImport.diag.root', {})
    case 'connector-template.schema-version':
      return copy('connectorImport.diag.schemaVersion', {})
    case 'connector-template.kind':
      return copy('connectorImport.diag.kind', {})
    case 'connector-template.slug':
      return copy('connectorImport.diag.slug', {})
    case 'connector-template.transport':
      return copy('connectorImport.diag.transport', {})
    case 'connector-template.command':
      return copy('connectorImport.diag.command', {})
    case 'connector-template.url':
      return withPath('connectorImport.diag.url', diagnostic)
    case 'connector-template.url-protocol':
      return withPath('connectorImport.diag.urlProtocol', diagnostic)
    case 'connector-template.url-credentials':
      return withPath('connectorImport.diag.urlCredentials', diagnostic)
    case 'connector-template.url-secret':
      return withPath('connectorImport.diag.urlSecret', diagnostic)
    case 'connector-template.url-required':
      return copy('connectorImport.diag.urlRequired', {})
    case 'connector-template.local-command':
      return withPath('connectorImport.diag.localCommand', diagnostic)
    case 'connector-template.local-argument':
      return withPath('connectorImport.diag.localArgument', diagnostic)
    case 'connector-template.argument-line-break':
      return withPath('connectorImport.diag.argumentLineBreak', diagnostic)
    case 'connector-template.argument-secret':
      return withPath('connectorImport.diag.argumentSecret', diagnostic)
    case 'connector-template.stdio-remote-fields':
      return copy('connectorImport.diag.stdioRemoteFields', {})
    case 'connector-template.stdio-headers':
      return copy('connectorImport.diag.stdioHeaders', {})
    case 'connector-template.remote-command':
      return copy('connectorImport.diag.remoteCommand', {})
    case 'connector-template.remote-environment':
      return copy('connectorImport.diag.remoteEnvironment', {})
    case 'connector-template.oauth-headers':
      return copy('connectorImport.diag.oauthHeaders', {})
    case 'connector-template.reserved-name':
      return withValue('connectorImport.diag.reservedName', diagnostic)
    case 'connector-template.duplicate-name':
      return withValue('connectorImport.diag.duplicateName', diagnostic)
    case 'connector-template.identity-conflict': {
      const kind = diagnostic.params?.kind
      if (kind === 'name') return withValue('connectorImport.diag.identityConflictName', diagnostic)
      if (kind === 'id') return withValue('connectorImport.diag.identityConflictId', diagnostic)
      return undefined
    }
    case 'connector-template.reserved-slug':
      return withValue('connectorImport.diag.reservedSlug', diagnostic)
    case 'connector-template.duplicate-slug':
      return withValue('connectorImport.diag.duplicateSlug', diagnostic)
    default:
      return undefined
  }
}
