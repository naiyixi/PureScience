// A tiny, namespace-agnostic field reader for the XML these APIs return.
//
// Why not DOMParser: the bundled connector descriptors parse PubMed XML with it, and that is exactly why they
// cannot move into the main process — `new DOMParser()` does not exist in Node. An external MCP server has to
// work without a DOM, so the extraction lives here: find the tag, take its text, decode the five XML entities
// that actually appear in titles and abstracts. Anything richer (attributes, nesting) is done by narrowing the
// slice first with `slices()`.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

export const decodeXmlEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[entity] ?? whole
  })

/** Text of every occurrence of `tag`, in document order. A namespace prefix on the tag is ignored. */
export const tagTexts = (xml: string, tag: string): string[] => {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`,
    'gu'
  )
  const values: string[] = []
  for (const match of xml.matchAll(pattern)) {
    values.push(decodeXmlEntities((match[1] ?? '').replace(/<[^>]+>/gu, '')).trim())
  }
  return values
}

export const tagText = (xml: string, tag: string): string | undefined => {
  const [first] = tagTexts(xml, tag)
  return first === undefined || first === '' ? undefined : first
}

/** The inner XML of every `tag` element, for reading nested fields without a DOM. */
export const slices = (xml: string, tag: string): string[] => {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`,
    'gu'
  )
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? '')
}

/** Attribute of the first element carrying `tag`, e.g. `href` of `<link href="…"/>`. */
export const attributeOf = (xml: string, tag: string, attribute: string): string | undefined => {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*\\b${attribute}="([^"]*)"`, 'u')
  const match = pattern.exec(xml)
  return match?.[1] === undefined ? undefined : decodeXmlEntities(match[1])
}
