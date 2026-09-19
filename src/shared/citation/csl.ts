// CSL (Citation Style Language) import with an explicit supported subset.
//
// Why a subset and not a full citeproc: shipping a complete CSL engine is a large, unverifiable
// surface, and a half-faithful renderer that silently drops constructs is worse than no import at
// all. So the importer validates the document, keeps its provenance (license required — an
// unattributable style is not installed), compiles the constructs we can render faithfully, and
// names every construct it skips. A rendered entry always carries those names back to the caller.
//
// This module is environment-free: it uses a small XML reader rather than a DOM, so it runs in the
// main process, the renderer, and tests alike.

import { locatorFor, parseAuthorName } from './names'
import type {
  CitationFormatResult,
  CitationItem,
  CitationStyleDefinition,
  CitationStyleProvenance
} from './types'

// ---- minimal XML reader ---------------------------------------------------------------------

type XmlElement = {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
}

type XmlNode = { kind: 'element'; element: XmlElement } | { kind: 'text'; text: string }

const decodeEntities = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')

const parseAttributes = (raw: string): Record<string, string> => {
  const attributes: Record<string, string> = {}
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match = re.exec(raw)
  while (match) {
    attributes[match[1]] = decodeEntities(match[3] ?? match[4] ?? '')
    match = re.exec(raw)
  }
  return attributes
}

export class CslXmlError extends Error {}

// Parses the element/text structure CSL documents use. Throws CslXmlError on malformed markup so the
// importer can report a named failure instead of importing a truncated style.
export const parseXmlDocument = (xml: string): XmlElement => {
  const source = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  const root: XmlElement = { name: '#document', attributes: {}, children: [] }
  const stack: XmlElement[] = [root]
  const tagRe = /<(\/?)([\w:.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let cursor = 0
  let match = tagRe.exec(source)

  const pushText = (text: string): void => {
    const decoded = decodeEntities(text)
    if (decoded.trim()) stack[stack.length - 1].children.push({ kind: 'text', text: decoded })
  }

  while (match) {
    pushText(source.slice(cursor, match.index))
    const [, closing, name, attributeText, selfClosing] = match
    if (closing) {
      const current = stack.pop()
      if (!current || current.name !== name) throw new CslXmlError(`Unbalanced tag: </${name}>`)
    } else {
      const element: XmlElement = { name, attributes: parseAttributes(attributeText), children: [] }
      stack[stack.length - 1].children.push({ kind: 'element', element })
      if (!selfClosing) stack.push(element)
    }
    cursor = match.index + match[0].length
    match = tagRe.exec(source)
  }
  pushText(source.slice(cursor))
  if (stack.length !== 1) throw new CslXmlError(`Unbalanced tag: <${stack[stack.length - 1].name}>`)
  return root
}

const childElements = (element: XmlElement, name?: string): XmlElement[] =>
  element.children
    .filter((child): child is { kind: 'element'; element: XmlElement } => child.kind === 'element')
    .map((child) => child.element)
    .filter((child) => !name || child.name === name)

const firstChild = (element: XmlElement, name: string): XmlElement | undefined =>
  childElements(element, name)[0]

const textOf = (element: XmlElement): string =>
  element.children
    .map((child) => (child.kind === 'text' ? child.text : textOf(child.element)))
    .join('')
    .trim()

// ---- compiled program -----------------------------------------------------------------------

export type CslFormatting = {
  prefix?: string
  suffix?: string
  delimiter?: string
  textCase?: string
  stripPeriods?: boolean
  quotes?: boolean
}

export type CslNameOptions = CslFormatting & {
  variable: string
  initializeWith?: string
  nameAsSortOrder?: 'all' | 'first' | boolean
  and?: 'text' | 'symbol'
  etAlMin?: number
  etAlUseFirst?: number
  etAlTerm?: string
  delimiterPrecedence?: boolean
}

export type CslCondition = {
  variables?: string[]
  types?: string[]
  isNumeric?: string[]
  match: 'any' | 'all' | 'none'
  negated?: boolean
}

export type CslNode =
  | ({
      kind: 'text'
      variable?: string
      macro?: string
      term?: string
      value?: string
    } & CslFormatting)
  | ({ kind: 'group'; children: CslNode[] } & CslFormatting)
  | {
      kind: 'choose'
      branches: { condition: CslCondition; children: CslNode[] }[]
      otherwise?: CslNode[]
    }
  | ({ kind: 'names' } & CslNameOptions)
  | ({ kind: 'date'; variable: string; parts: { name: string; form?: string }[] } & CslFormatting)
  | ({ kind: 'number'; variable: string } & CslFormatting)
  | ({ kind: 'label'; variable: string; form?: string; plural?: string } & CslFormatting)

export type CslProgram = {
  layout: CslNode[]
  // The in-text layout, when the style declares one. It is what tells us whether the style numbers
  // its entries (citation-number) or reads author-date, which the list renderer needs to know.
  citationLayout?: CslNode[]
  locale: string
}

export type ImportedCitationStyle = {
  id: string
  label: string
  license: string
  sourceUrl?: string
  updated?: string
  defaultLocale?: string
  contentHash: string
  fileName: string
  importedAt: number
  unsupported: readonly string[]
  program: CslProgram
}

export type CslRejectReason =
  | 'xml-parse-failed'
  | 'not-a-style'
  | 'missing-info'
  | 'missing-title'
  | 'missing-license'
  | 'missing-bibliography'
  | 'builtin-id-collision'

export type CslImportOutcome =
  | { status: 'imported'; style: ImportedCitationStyle }
  | { status: 'rejected'; reason: CslRejectReason; detail?: string }

// CSL element names our renderer implements. Everything else is recorded by name — including
// constructs such as <sort> whose omission changes the output order, which the user must see.
const SUPPORTED_ELEMENTS = new Set([
  'style',
  'info',
  'bibliography',
  'citation',
  'layout',
  'macro',
  'text',
  'group',
  'choose',
  'if',
  'else-if',
  'else',
  'names',
  'name',
  'et-al',
  'label',
  'date',
  'date-part',
  'number'
])

// <info> is metadata we read rather than render; its children are never "unsupported constructs".
const METADATA_CONTAINER = 'info'

// Formatting attributes plain text cannot carry. They are named so the user knows the imported
// style's visual outcome is flattened, rather than being quietly dropped.
const FLATTENED_ATTRIBUTES = new Set([
  'font-style',
  'font-variant',
  'font-weight',
  'text-decoration',
  'vertical-align',
  'display',
  'page-range-format',
  'name-form'
])

const formattingOf = (element: XmlElement): CslFormatting => {
  const { attributes } = element
  const formatting: CslFormatting = {
    prefix: attributes.prefix,
    suffix: attributes.suffix,
    delimiter: attributes.delimiter,
    textCase: attributes['text-case'],
    stripPeriods: attributes['strip-periods'] === 'true',
    quotes: attributes.quotes === 'true'
  }
  return formatting
}

type CompileContext = {
  macros: Map<string, XmlElement>
  unsupported: Set<string>
  defaultLocale: string
}

const compileChildren = (element: XmlElement, context: CompileContext): CslNode[] =>
  childElements(element).flatMap((child) => compileNode(child, context))

// Records every construct the document uses that this engine does not render, so an imported style
// never claims fidelity it does not have. Walks the whole style body, not just the paths we compile.
const scanUnsupported = (element: XmlElement, context: CompileContext): void => {
  for (const child of childElements(element)) {
    if (child.name !== METADATA_CONTAINER) {
      if (!SUPPORTED_ELEMENTS.has(child.name)) context.unsupported.add(child.name)
      for (const attribute of Object.keys(child.attributes)) {
        if (FLATTENED_ATTRIBUTES.has(attribute)) context.unsupported.add(`attribute:${attribute}`)
      }
      scanUnsupported(child, context)
    }
  }
}

const compileCondition = (element: XmlElement): CslCondition => {
  const { attributes } = element
  return {
    variables: attributes.variable?.split(/\s+/).filter(Boolean),
    types: attributes.type?.split(/\s+/).filter(Boolean),
    isNumeric: attributes['is-numeric']?.split(/\s+/).filter(Boolean),
    match: (attributes.match as CslCondition['match']) ?? 'all',
    negated: element.name === 'else-if' ? false : undefined
  }
}

const compileNode = (element: XmlElement, context: CompileContext): CslNode[] => {
  if (!SUPPORTED_ELEMENTS.has(element.name)) {
    context.unsupported.add(element.name)
    return []
  }
  for (const attribute of Object.keys(element.attributes)) {
    if (FLATTENED_ATTRIBUTES.has(attribute)) context.unsupported.add(`attribute:${attribute}`)
  }
  if (element.name === 'text' && element.attributes['variable'] === 'locator') {
    context.unsupported.add('variable:locator')
    return []
  }
  if (element.name === 'names' && childElements(element, 'substitute').length > 0) {
    context.unsupported.add('names:substitute')
  }
  if (element.name === 'date' && firstChild(element, 'date-part') === undefined) {
    context.unsupported.add('date:no-parts')
  }

  switch (element.name) {
    case 'text':
      return [{ kind: 'text', ...element.attributes, ...formattingOf(element) }]
    case 'group':
      return [
        { kind: 'group', children: compileChildren(element, context), ...formattingOf(element) }
      ]
    case 'choose': {
      const branches = childElements(element, 'if').map((branch) => ({
        condition: compileCondition(branch),
        children: compileChildren(branch, context)
      }))
      for (const branch of childElements(element, 'else-if')) {
        branches.push({
          condition: compileCondition(branch),
          children: compileChildren(branch, context)
        })
      }
      const otherwise = childElements(element, 'else').flatMap((branch) =>
        compileChildren(branch, context)
      )
      return [{ kind: 'choose', branches, otherwise: otherwise.length ? otherwise : undefined }]
    }
    case 'names': {
      const nameElement = firstChild(element, 'name')
      const etAl = firstChild(element, 'et-al')
      const nameAsSortOrder = nameElement?.attributes['name-as-sort-order']
      return [
        {
          kind: 'names',
          variable: element.attributes.variable ?? 'author',
          initializeWith: nameElement?.attributes['initialize-with'],
          nameAsSortOrder:
            nameAsSortOrder === 'all' || nameAsSortOrder === 'first'
              ? nameAsSortOrder
              : nameAsSortOrder === 'true'
                ? true
                : undefined,
          and: nameElement?.attributes.and as CslNameOptions['and'],
          etAlMin: nameElement?.attributes['et-al-min']
            ? Number(nameElement.attributes['et-al-min'])
            : undefined,
          etAlUseFirst: nameElement?.attributes['et-al-use-first']
            ? Number(nameElement.attributes['et-al-use-first'])
            : undefined,
          etAlTerm: etAl?.attributes.term ?? 'et al.',
          delimiter: nameElement?.attributes.delimiter,
          delimiterPrecedence:
            nameElement?.attributes['delimiter-precedence'] === 'after-inverted-name',
          ...formattingOf(element)
        }
      ]
    }
    case 'date':
      return [
        {
          kind: 'date',
          variable: element.attributes.variable ?? 'issued',
          parts: childElements(element, 'date-part').map((part) => ({
            name: part.attributes.name ?? 'year',
            form: part.attributes.form
          })),
          ...formattingOf(element)
        }
      ]
    case 'number':
      return [
        { kind: 'number', variable: element.attributes.variable ?? '', ...formattingOf(element) }
      ]
    case 'label':
      return [
        {
          kind: 'label',
          variable: element.attributes.variable ?? '',
          form: element.attributes.form,
          plural: element.attributes.plural,
          ...formattingOf(element)
        }
      ]
    default:
      return []
  }
}

// ---- rendering ------------------------------------------------------------------------------

const CSL_TYPE_BY_ITEM_TYPE: Record<string, string> = {
  'journal-article': 'article-journal',
  'conference-paper': 'paper-conference',
  preprint: 'article',
  book: 'book',
  chapter: 'chapter',
  report: 'report',
  dataset: 'dataset',
  thesis: 'thesis',
  web: 'webpage',
  unknown: 'article'
}

type RenderState = {
  item: CitationItem
  index?: number
  retrievedAt?: string
  variables: Record<string, string>
  numeric: Set<string>
}

const renderVariables = (item: CitationItem, index?: number): Record<string, string> => {
  const variables: Record<string, string> = {
    title: item.title,
    'container-title': item.containerTitle ?? '',
    'container-title-short': item.containerTitle ?? '',
    volume: item.volume ?? '',
    issue: item.issue ?? '',
    page: item.pages ?? '',
    'page-first': item.pages?.split(/[-–]/)[0] ?? '',
    DOI: item.doi ?? '',
    URL: item.url ?? '',
    publisher: item.publisher ?? '',
    genre: item.itemType ?? '',
    type: CSL_TYPE_BY_ITEM_TYPE[item.itemType ?? 'unknown'] ?? 'article',
    'citation-number': index ? String(index) : '',
    'citation-label': item.title.slice(0, 12)
  }
  return variables
}

// The variables a CSL is-numeric test may name; exported so callers can explain the check.
export const numericCslVariables = (): readonly string[] => [
  'volume',
  'issue',
  'page',
  'citation-number'
]

const evaluateCondition = (condition: CslCondition, state: RenderState): boolean => {
  const results: boolean[] = []
  for (const variable of condition.variables ?? []) {
    results.push(Boolean(state.variables[variable]?.trim()))
  }
  for (const type of condition.types ?? []) {
    results.push(state.variables.type === type || state.variables.genre === type)
  }
  for (const variable of condition.isNumeric ?? []) {
    const value = state.variables[variable] ?? ''
    results.push(Boolean(value.trim()) && /^[\d\s,.\-–:]+$/.test(value))
  }
  if (results.length === 0) return false
  if (condition.match === 'any') return results.some(Boolean)
  if (condition.match === 'none') return !results.some(Boolean)
  return results.every(Boolean)
}

const applyCase = (value: string, textCase?: string): string => {
  switch (textCase) {
    case 'uppercase':
      return value.toUpperCase()
    case 'lowercase':
      return value.toLowerCase()
    case 'capitalize-first':
      return value.charAt(0).toUpperCase() + value.slice(1)
    case 'capitalize-all':
      return value.replace(/\b\p{Ll}/gu, (letter) => letter.toUpperCase())
    default:
      return value
  }
}

const applyFormatting = (value: string, formatting: CslFormatting): string => {
  if (!value.trim()) return ''
  let text = formatting.stripPeriods ? value.replace(/\./g, '') : value
  text = applyCase(text, formatting.textCase)
  if (formatting.quotes) text = `“${text}”`
  // CSL processors suppress a doubled separator: "Huang, M." + ". " must not read "M.. ".
  const suffix =
    text.endsWith('.') && formatting.suffix?.startsWith('.')
      ? formatting.suffix.slice(1)
      : (formatting.suffix ?? '')
  return `${formatting.prefix ?? ''}${text}${suffix}`
}

const renderName = (
  name: ReturnType<typeof parseAuthorName>,
  options: CslNameOptions,
  position: number
): string => {
  if (name.familyFirst || !name.given) return name.family
  const initializeWith = options.initializeWith ?? '. '
  const initials = name.given
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ''}${initializeWith.trim()}`)
    .join(initializeWith.startsWith(' ') ? ' ' : ' ')
  const sortOrder =
    options.nameAsSortOrder === 'all' || (options.nameAsSortOrder === 'first' && position === 0)
  return sortOrder ? `${name.family}, ${initials}` : `${initials} ${name.family}`.trim()
}

const renderNames = (node: CslNameOptions, state: RenderState): string => {
  const authors = state.item.authors
  if (authors.length === 0) return ''
  const delimiter = node.delimiter ?? ', '
  const etAlMin = node.etAlMin ?? Number.POSITIVE_INFINITY
  const useFirst = node.etAlUseFirst ?? authors.length
  const truncated = authors.length >= etAlMin
  const kept = truncated ? authors.slice(0, useFirst) : authors
  const rendered = kept.map((author, position) =>
    renderName(parseAuthorName(author.name), node, position)
  )
  const etAlText = truncated ? `${delimiter}${node.etAlTerm ?? 'et al.'}` : ''
  const joined = rendered.join(delimiter)
  const withAnd =
    !truncated && node.and === 'text' && rendered.length > 1
      ? `${rendered.slice(0, -1).join(delimiter)} and ${rendered[rendered.length - 1]}`
      : !truncated && node.and === 'symbol' && rendered.length > 1
        ? `${rendered.slice(0, -1).join(delimiter)} & ${rendered[rendered.length - 1]}`
        : joined
  return applyFormatting(`${withAnd}${etAlText}`, node)
}

const renderDate = (
  node: { variable: string; parts: { name: string; form?: string }[] } & CslFormatting,
  state: RenderState
): string => {
  const year = state.item.year
  if (!year) return ''
  const rendered = node.parts
    .map((part) => {
      if (part.name === 'year') return part.form === 'short' ? String(year).slice(2) : String(year)
      // Our records carry a year, not a full publication date: a style asking for month/day gets the
      // parts it can have and the omission is reported by the caller.
      return ''
    })
    .filter(Boolean)
    .join(node.delimiter ?? ' ')
  return applyFormatting(rendered, node)
}

const renderNode = (node: CslNode, state: RenderState): string => {
  switch (node.kind) {
    case 'text': {
      if (node.value !== undefined) return applyFormatting(node.value, node)
      const variable = node.variable ?? node.term ?? ''
      if (variable === 'citation-number') {
        return applyFormatting(state.index ? String(state.index) : '', node)
      }
      return applyFormatting(state.variables[variable] ?? '', node)
    }
    case 'group': {
      const rendered = node.children.map((child) => renderNode(child, state)).filter(Boolean)
      if (rendered.length === 0) return ''
      return applyFormatting(rendered.join(node.delimiter ?? ''), node)
    }
    case 'choose': {
      for (const branch of node.branches) {
        if (evaluateCondition(branch.condition, state)) {
          return branch.children
            .map((child) => renderNode(child, state))
            .filter(Boolean)
            .join('')
        }
      }
      return (node.otherwise ?? [])
        .map((child) => renderNode(child, state))
        .filter(Boolean)
        .join('')
    }
    case 'names':
      return renderNames(node, state)
    case 'date':
      return renderDate(node, state)
    case 'number':
      return applyFormatting(state.variables[node.variable] ?? '', node)
    case 'label':
      return ''
    default:
      return ''
  }
}

const renderProgram = (
  program: CslProgram,
  item: CitationItem,
  index?: number,
  retrievedAt?: string
): string => {
  const state: RenderState = {
    item,
    index,
    retrievedAt,
    variables: renderVariables(item, index),
    numeric: new Set()
  }
  return renderProgramNodes(program, state)
}

const renderProgramNodes = (program: CslProgram, state: RenderState): string =>
  program.layout
    .map((node) => renderNode(node, state))
    .filter(Boolean)
    .join('')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    // A style whose last element already ends in a period keeps its own closing period out of the
    // render: "A short note." must not become "A short note..". Only trailing runs collapse, so a
    // quotation's interior ellipsis is untouched.
    .replace(/([.,;:])\1+$/, '$1')
    .trim()

// Whether the style numbers its entries in text. Used to pick the list convention for an import.
export const cslStyleIsNumeric = (program: CslProgram): boolean => {
  const stack: CslNode[] = [...(program.citationLayout ?? [])]
  while (stack.length > 0) {
    const node = stack.pop() as CslNode
    if (node.kind === 'text' && node.variable === 'citation-number') return true
    if (node.kind === 'group') stack.push(...node.children)
    if (node.kind === 'choose') {
      for (const branch of node.branches) stack.push(...branch.children)
      if (node.otherwise) stack.push(...node.otherwise)
    }
  }
  return false
}

// ---- import ---------------------------------------------------------------------------------

const slugifyStyleId = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'imported'

// Hashing is injected rather than imported: the shared layer runs in the renderer too, where a Node
// crypto import would not resolve. Main passes a SHA-256 implementation; tests pass a stub.
export type CslDocumentHasher = (xml: string) => string

const buildStyleId = (cslId: string | undefined, title: string): string => {
  const candidate = cslId ? slugifyStyleId(cslId.split('/').pop() ?? '') : ''
  const fromTitle = slugifyStyleId(title)
  return `csl-import:${candidate || fromTitle}`
}

export const importCslStyle = (
  xml: string,
  fileName: string,
  options: {
    hash: CslDocumentHasher
    builtinStyleIds?: readonly string[]
    importedAt?: number
  }
): CslImportOutcome => {
  let document: XmlElement
  try {
    document = parseXmlDocument(xml)
  } catch (error) {
    return {
      status: 'rejected',
      reason: 'xml-parse-failed',
      detail: error instanceof Error ? error.message : undefined
    }
  }
  const style = childElements(document).find((element) => element.name === 'style')
  if (!style) return { status: 'rejected', reason: 'not-a-style' }
  const info = firstChild(style, 'info')
  if (!info) return { status: 'rejected', reason: 'missing-info' }

  const title = firstChild(info, 'title') ? textOf(firstChild(info, 'title')!) : ''
  if (!title) return { status: 'rejected', reason: 'missing-title' }

  // Fail closed on attribution: a style without a declared license is not installed, because a
  // formatted list has to be traceable to the licence of the style that produced it.
  const rights = firstChild(info, 'rights')
  const license = rights?.attributes.license ?? (rights ? textOf(rights) : '')
  if (!license.trim()) return { status: 'rejected', reason: 'missing-license' }

  const bibliography = firstChild(style, 'bibliography')
  const layout = bibliography ? firstChild(bibliography, 'layout') : undefined
  if (!bibliography || !layout) return { status: 'rejected', reason: 'missing-bibliography' }

  const cslId = firstChild(info, 'id') ? textOf(firstChild(info, 'id')!) : undefined
  const id = buildStyleId(cslId, title)
  if (options.builtinStyleIds?.includes(id)) {
    return { status: 'rejected', reason: 'builtin-id-collision', detail: id }
  }

  const context: CompileContext = {
    macros: new Map(childElements(style, 'macro').map((macro) => [macro.attributes.name, macro])),
    unsupported: new Set<string>(),
    defaultLocale: style.attributes['default-locale'] ?? 'en-US'
  }
  // Anything in the document this engine cannot render is named before compiling, so the report is
  // about the style as written rather than only about the branches a layout happens to take.
  scanUnsupported(style, context)
  // Macros expand inline; the call site's own affixes must survive the expansion, so an expanded
  // macro is wrapped in a group that carries the call's prefix/suffix/delimiter.
  const compileMacroCall = (call: XmlElement, depth = 0): CslNode[] => {
    const macroName = call.attributes.macro ?? ''
    const expanded = compileMacroChildren(macroName, depth)
    if (expanded.length === 0) return []
    const formatting = formattingOf(call)
    const hasAffixes = Boolean(
      formatting.prefix || formatting.suffix || formatting.delimiter || formatting.textCase
    )
    return hasAffixes ? [{ kind: 'group', children: expanded, ...formatting }] : expanded
  }
  const compileMacroChildren = (macroName: string, depth = 0): CslNode[] => {
    if (depth > 8) {
      context.unsupported.add('macro:recursion')
      return []
    }
    const macro = context.macros.get(macroName)
    if (!macro) return []
    return macro.children.flatMap((child) => {
      if (child.kind === 'text') return []
      if (child.element.name === 'text' && child.element.attributes.macro) {
        return compileMacroCall(child.element, depth + 1)
      }
      return compileNode(child.element, context)
    })
  }

  const layoutNodes: CslNode[] = []
  for (const child of layout.children) {
    if (child.kind === 'text') continue
    if (child.element.name === 'text' && child.element.attributes.macro) {
      layoutNodes.push(...compileMacroCall(child.element))
      continue
    }
    layoutNodes.push(...compileNode(child.element, context))
  }

  // The in-text layout is compiled for one purpose: deciding whether this convention numbers its
  // entries. We do not render in-text markers from an imported style (documented limitation).
  const citation = firstChild(style, 'citation')
  const citationLayout = citation ? firstChild(citation, 'layout') : undefined
  const citationNodes: CslNode[] = []
  if (citationLayout) {
    for (const child of citationLayout.children) {
      if (child.kind === 'text') continue
      if (child.element.name === 'text' && child.element.attributes.macro) {
        citationNodes.push(...compileMacroCall(child.element))
        continue
      }
      citationNodes.push(...compileNode(child.element, context))
    }
  }

  // The layout's own affixes are part of the style: a trailing delimiter on <layout> is what closes
  // a bibliography entry, and dropping it silently would truncate every rendered entry. The children
  // are copied — wrapping the array in place would make the group its own child.
  const layoutFormatting = formattingOf(layout)
  const citationFormatting = citationLayout ? formattingOf(citationLayout) : {}
  if (layoutFormatting.prefix || layoutFormatting.suffix || layoutFormatting.delimiter) {
    const wrapped: CslNode = { kind: 'group', children: [...layoutNodes], ...layoutFormatting }
    layoutNodes.length = 0
    layoutNodes.push(wrapped)
  }
  if (
    citationLayout &&
    (citationFormatting.prefix || citationFormatting.suffix || citationFormatting.delimiter)
  ) {
    const wrapped: CslNode = { kind: 'group', children: [...citationNodes], ...citationFormatting }
    citationNodes.length = 0
    citationNodes.push(wrapped)
  }

  const program: CslProgram = {
    layout: layoutNodes,
    locale: context.defaultLocale,
    citationLayout: citationNodes
  }
  const provenance: CitationStyleProvenance = {
    fileName,
    importedAt: options.importedAt ?? Date.now(),
    license: license.trim(),
    sourceUrl: firstChild(info, 'link')?.attributes.href,
    styleId: cslId,
    updated: firstChild(info, 'updated') ? textOf(firstChild(info, 'updated')!) : undefined,
    defaultLocale: context.defaultLocale,
    contentHash: options.hash(xml)
  }

  return {
    status: 'imported',
    style: {
      id,
      label: title,
      license: provenance.license,
      sourceUrl: provenance.sourceUrl,
      updated: provenance.updated,
      defaultLocale: context.defaultLocale,
      contentHash: provenance.contentHash,
      fileName,
      importedAt: provenance.importedAt,
      unsupported: [...context.unsupported].sort(),
      program
    }
  }
}

// Turns a stored import into a first-class style the shared registry can format with. Warnings carry
// both the missing fields of the record and the constructs this engine skipped.
export const citationStyleFromImport = (
  imported: ImportedCitationStyle,
  labelZh?: string
): CitationStyleDefinition => ({
  id: imported.id,
  label: imported.label,
  labelZh: labelZh ?? imported.label,
  family: cslStyleIsNumeric(imported.program) ? 'numeric' : 'author-date',
  locale: 'en',
  source: 'imported',
  uses: ['authors', 'containerTitle', 'year', 'volume', 'issue', 'pages', 'doi'],
  license: imported.license,
  unsupportedElements: imported.unsupported,
  provenance: {
    fileName: imported.fileName,
    importedAt: imported.importedAt,
    license: imported.license,
    sourceUrl: imported.sourceUrl,
    styleId: imported.label,
    updated: imported.updated,
    defaultLocale: imported.defaultLocale,
    contentHash: imported.contentHash
  },
  format: (item, context): CitationFormatResult => {
    const text = renderProgram(imported.program, item, context.index, context.retrievedAt)
    const warnings = [...imported.unsupported.map((name) => `unsupported:${name}`)]
    if (!text) warnings.push('style:empty-render')
    if (!item.year) warnings.push('field:year')
    if (!item.containerTitle) warnings.push('field:containerTitle')
    // Web-only records need an access date; without one the render is shorter than the style intends.
    if (!item.doi && !item.url && locatorFor(item) === '') warnings.push('style:no-locator')
    return { text, warnings }
  }
})
