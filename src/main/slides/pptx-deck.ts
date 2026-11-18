import { strToU8, zipSync } from 'fflate'

// Builds a real PresentationML (.pptx) deck from a plain outline, with no Office dependency and no
// template file. The app already renders .pptx previews, so a deck written here opens in the product
// like any other slide file; the package is also readable by third-party Office readers, which is what
// the acceptance reading checks (an independent parser, not our own writer's opinion of itself).
//
// Three rules this module keeps, because each one is a way such a writer usually lies:
//   1. Nothing is invented. A missing author is an absent `dc:creator`, never a placeholder name; there
//      is no default theme author, company or date stamped into the package.
//   2. What the user typed is what the file says. Every text field is XML-escaped and length-capped with
//      a named refusal instead of being silently truncated.
//   3. The bytes are a function of the input only. Every zip entry carries the zip epoch (1980-01-01)
//      and no part records a timestamp, so the same outline always hashes to the same SHA-256 — which is
//      what makes an artifact version's checksum mean something.

export const PPTX_DECK_MAX_SECTIONS = 60
export const PPTX_DECK_MAX_BULLETS_PER_SECTION = 12
export const PPTX_DECK_MAX_TEXT_CHARS = 2_000
export const PPTX_DECK_MAX_TOTAL_TEXT_CHARS = 40_000

export type PptxDeckSection = {
  /** Slide heading. Required: a slide with no heading is a slide nobody can find later. */
  heading: string
  /** Body bullets, in reading order. Empty is allowed (a heading-only slide). */
  bullets: string[]
}

export type PptxDeckInput = {
  title: string
  subtitle?: string
  /** Written as `dc:creator` only when the caller actually has one. Never defaulted. */
  author?: string
  sections: PptxDeckSection[]
}

export type PptxDeckRefusal =
  | 'title-empty'
  | 'sections-empty'
  | 'section-heading-empty'
  | 'too-many-sections'
  | 'too-many-bullets'
  | 'text-too-long'
  | 'deck-too-large'

export type PptxDeckResult =
  | { ok: true; bytes: Uint8Array; slideCount: number; sha256Input: string }
  | { ok: false; refusal: PptxDeckRefusal; detail: string }

// 16:9 at 13.333in x 7.5in. Expressed in EMU (914400 per inch), the unit PresentationML uses.
const SLIDE_WIDTH_EMU = 12_192_000
const SLIDE_HEIGHT_EMU = 6_858_000
const MARGIN_EMU = 838_200
const CONTENT_WIDTH_EMU = SLIDE_WIDTH_EMU - MARGIN_EMU * 2

// Zip cannot encode a timestamp before 1980, and "now" would make the bytes depend on when the agent
// happened to run. Same convention as the session package archive.
const DECK_ENTRY_MTIME = new Date(1980, 0, 1, 0, 0, 0)

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const NS_PRESENTATION =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const escapeXml = (value: string): string =>
  value
    // eslint-disable-next-line no-control-regex -- XML 1.0 forbids these outright; they are stripped, not escaped.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')

// One text run. `sz` is hundredths of a point, matching `a:rPr/@sz`.
const run = (text: string, options: { sizePt: number; bold?: boolean; color?: string }): string => {
  const bold = options.bold ? ' b="1"' : ''
  const color = options.color
    ? `<a:solidFill><a:srgbClr val="${options.color}"/></a:solidFill>`
    : ''
  return (
    `<a:r><a:rPr lang="en-US" sz="${Math.round(options.sizePt * 100)}"${bold} dirty="0">` +
    `${color}</a:rPr><a:t>${escapeXml(text)}</a:t></a:r>`
  )
}

const paragraph = (
  text: string,
  options: { sizePt: number; bold?: boolean; color?: string; bullet?: boolean; align?: 'l' | 'ctr' }
): string => {
  const alignment = options.align ? ` algn="${options.align}"` : ''
  const bullet = options.bullet
    ? '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>'
    : `<a:pPr${alignment}/>`
  return `<a:p>${bullet}${run(text, options)}</a:p>`
}

// A text box shape. Explicit geometry (no placeholder inheritance) keeps the deck independent of the
// master/layout pair, so a reader that ignores the layout still shows every word.
const textBox = ({
  id,
  name,
  x,
  y,
  cx,
  cy,
  anchor = 't',
  paragraphs
}: {
  id: number
  name: string
  x: number
  y: number
  cx: number
  cy: number
  anchor?: 't' | 'ctr'
  paragraphs: string[]
}): string =>
  '<p:sp><p:nvSpPr>' +
  `<p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/>` +
  '</p:nvSpPr><p:spPr>' +
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>' +
  '</p:spPr><p:txBody>' +
  `<a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="${anchor}">` +
  '<a:normAutofit/></a:bodyPr><a:lstStyle/>' +
  paragraphs.join('') +
  '</p:txBody></p:sp>'

const shapeTree = (shapes: string[]): string =>
  '<p:spTree>' +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  shapes.join('') +
  '</p:spTree>'

const slidePart = (shapes: string[]): string =>
  `${XML_DECLARATION}<p:sld ${NS_PRESENTATION}><p:cSld>${shapeTree(shapes)}</p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'

const slideRelationships = (): string =>
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" ' +
  'Target="../slideLayouts/slideLayout1.xml"/></Relationships>'

// A blank layout: no placeholders, so every slide's text is exactly what this writer put there and a
// reader never has to reconcile inherited prompt text with real content.
const slideLayoutPart = (): string =>
  `${XML_DECLARATION}<p:sldLayout ${NS_PRESENTATION} type="blank" preserve="1">` +
  `<p:cSld name="Blank">${shapeTree([])}</p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'

const slideLayoutRelationships = (): string =>
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" ' +
  'Target="../slideMasters/slideMaster1.xml"/></Relationships>'

const slideMasterPart = (): string =>
  `${XML_DECLARATION}<p:sldMaster ${NS_PRESENTATION}>` +
  `<p:cSld>${shapeTree([])}</p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" ' +
  'folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '</p:sldMaster>'

const slideMasterRelationships = (): string =>
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" ' +
  'Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" ' +
  'Target="../theme/theme1.xml"/></Relationships>'

// A complete theme: clrScheme (12 slots), fontScheme (major/minor x latin/ea/cs), and the three
// format style lists the schema requires three entries each of. Office refuses a presentation whose
// theme is short of these, so they are spelled out rather than defaulted.
const themePart = (): string =>
  `${XML_DECLARATION}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">` +
  '<a:themeElements><a:clrScheme name="Office">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme>' +
  '<a:fontScheme name="Office">' +
  '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="Office">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill>' +
  '</a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:prstDash val="solid"/></a:ln>' +
  '</a:lnStyleLst>' +
  '<a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '</a:effectStyleLst>' +
  '<a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill>' +
  '</a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'

const presentationPart = (slideCount: number): string => {
  const slideIds = Array.from(
    { length: slideCount },
    (_value, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`
  ).join('')

  return (
    `${XML_DECLARATION}<p:presentation ${NS_PRESENTATION}>` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>'
  )
}

const presentationRelationships = (slideCount: number): string => {
  const slides = Array.from(
    { length: slideCount },
    (_value, index) =>
      `<Relationship Id="rId${index + 2}" ` +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ' +
      `Target="slides/slide${index + 1}.xml"/>`
  ).join('')

  return (
    `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" ' +
    'Target="slideMasters/slideMaster1.xml"/>' +
    slides +
    '</Relationships>'
  )
}

const contentTypes = (slideCount: number): string => {
  const slides = Array.from(
    { length: slideCount },
    (_value, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ` +
      'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
  ).join('')

  return (
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    slides +
    '<Override PartName="/docProps/core.xml" ' +
    'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>'
  )
}

const packageRelationships = (): string =>
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
  'Target="ppt/presentation.xml"/>' +
  '<Relationship Id="rId2" ' +
  'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" ' +
  'Target="docProps/core.xml"/></Relationships>'

// Core properties. No created/modified/lastModifiedBy: a file written by this module carries the
// document's own facts (title, and the author when the caller has one) and nothing about this machine.
const corePropertiesPart = ({ title, author }: { title: string; author?: string }): string =>
  `${XML_DECLARATION}<cp:coreProperties ` +
  'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
  'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  `<dc:title>${escapeXml(title)}</dc:title>` +
  (author ? `<dc:creator>${escapeXml(author)}</dc:creator>` : '') +
  '</cp:coreProperties>'

const titleSlide = ({ title, subtitle }: { title: string; subtitle?: string }): string => {
  const shapes = [
    textBox({
      id: 2,
      name: 'Title',
      x: MARGIN_EMU,
      y: 2_286_000,
      cx: CONTENT_WIDTH_EMU,
      cy: 1_600_200,
      anchor: 't',
      paragraphs: [paragraph(title, { sizePt: 40, bold: true })]
    })
  ]

  if (subtitle) {
    shapes.push(
      textBox({
        id: 3,
        name: 'Subtitle',
        x: MARGIN_EMU,
        y: 3_886_200,
        cx: CONTENT_WIDTH_EMU,
        cy: 1_143_000,
        paragraphs: [paragraph(subtitle, { sizePt: 20, color: '44546A' })]
      })
    )
  }

  return slidePart(shapes)
}

const sectionSlide = ({ heading, bullets }: PptxDeckSection): string => {
  const body =
    bullets.length > 0
      ? textBox({
          id: 3,
          name: 'Body',
          x: MARGIN_EMU,
          y: 2_011_680,
          cx: CONTENT_WIDTH_EMU,
          cy: 3_962_400,
          paragraphs: bullets.map((bullet) => paragraph(bullet, { sizePt: 18, bullet: true }))
        })
      : textBox({
          id: 3,
          name: 'Body',
          x: MARGIN_EMU,
          y: 2_011_680,
          cx: CONTENT_WIDTH_EMU,
          cy: 3_962_400,
          paragraphs: [paragraph('', { sizePt: 18 })]
        })

  return slidePart([
    textBox({
      id: 2,
      name: 'Heading',
      x: MARGIN_EMU,
      y: 609_600,
      cx: CONTENT_WIDTH_EMU,
      cy: 1_188_720,
      paragraphs: [paragraph(heading, { sizePt: 32, bold: true })]
    }),
    body
  ])
}

const textLength = (value: string): number => [...value].length

// Validates the outline against the same bounds the writer uses, returning a named refusal so the tool
// can tell the model exactly what to fix instead of failing deep inside the zip step.
const refusalFor = (
  input: PptxDeckInput
): { refusal: PptxDeckRefusal; detail: string } | undefined => {
  if (textLength(input.title.trim()) === 0) {
    return { refusal: 'title-empty', detail: 'A deck needs a non-empty title.' }
  }

  if (input.sections.length === 0) {
    return {
      refusal: 'sections-empty',
      detail: 'A deck needs at least one section (one slide each).'
    }
  }

  if (input.sections.length > PPTX_DECK_MAX_SECTIONS) {
    return {
      refusal: 'too-many-sections',
      detail: `At most ${PPTX_DECK_MAX_SECTIONS} sections fit in one deck; got ${input.sections.length}.`
    }
  }

  let total =
    textLength(input.title) + textLength(input.subtitle ?? '') + textLength(input.author ?? '')

  for (const [index, section] of input.sections.entries()) {
    if (textLength(section.heading.trim()) === 0) {
      return {
        refusal: 'section-heading-empty',
        detail: `Section ${index + 1} has an empty heading.`
      }
    }

    if (section.bullets.length > PPTX_DECK_MAX_BULLETS_PER_SECTION) {
      return {
        refusal: 'too-many-bullets',
        detail:
          `Section ${index + 1} has ${section.bullets.length} bullets; at most ` +
          `${PPTX_DECK_MAX_BULLETS_PER_SECTION} fit on one slide. Split it into two sections.`
      }
    }

    for (const text of [section.heading, ...section.bullets]) {
      if (textLength(text) > PPTX_DECK_MAX_TEXT_CHARS) {
        return {
          refusal: 'text-too-long',
          detail: `A line in section ${index + 1} is longer than ${PPTX_DECK_MAX_TEXT_CHARS} characters.`
        }
      }

      total += textLength(text)
    }
  }

  if (total > PPTX_DECK_MAX_TOTAL_TEXT_CHARS) {
    return {
      refusal: 'deck-too-large',
      detail: `The deck carries ${total} characters of text; the bound is ${PPTX_DECK_MAX_TOTAL_TEXT_CHARS}.`
    }
  }

  return undefined
}

export type DeckFilenameRefusal = 'filename-empty' | 'filename-has-path' | 'filename-not-pptx'

export type DeckFilenameResult =
  { ok: true; filename: string } | { ok: false; refusal: DeckFilenameRefusal; detail: string }

// A deck name is a NAME, never a path: the writer decides the directory, so a name carrying `../` or a
// separator must be refused rather than resolved (that resolution is where a write escapes the session).
export const validateDeckFilename = (value: string): DeckFilenameResult => {
  const filename = value.trim()

  if (filename.length === 0) {
    return {
      ok: false,
      refusal: 'filename-empty',
      detail: 'A file name is required, e.g. "slides.pptx".'
    }
  }

  if (/[\\/]/u.test(filename) || filename === '.' || filename === '..') {
    return {
      ok: false,
      refusal: 'filename-has-path',
      detail: `"${filename}" carries a path. Pass a bare file name — the app chooses the directory.`
    }
  }

  // eslint-disable-next-line no-control-regex -- a control character in a file name is a corrupt name.
  if (/[\u0000-\u001f\u007f]/u.test(filename)) {
    return {
      ok: false,
      refusal: 'filename-has-path',
      detail: 'The file name contains a control character.'
    }
  }

  if (!/\.pptx$/iu.test(filename)) {
    return {
      ok: false,
      refusal: 'filename-not-pptx',
      detail: `"${filename}" does not end in .pptx; this writer only produces PresentationML decks.`
    }
  }

  return { ok: true, filename }
}

// Serializes the outline into the package bytes. The result is a pure function of the input: no clock, no
// host name, no locale, and a fixed zip timestamp.
export const buildPptxDeck = (input: PptxDeckInput): PptxDeckResult => {
  const refusal = refusalFor(input)

  if (refusal) return { ok: false, ...refusal }

  const slides = [titleSlide(input), ...input.sections.map(sectionSlide)]
  const slideCount = slides.length
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes(slideCount)),
    '_rels/.rels': strToU8(packageRelationships()),
    'docProps/core.xml': strToU8(corePropertiesPart({ title: input.title, author: input.author })),
    'ppt/presentation.xml': strToU8(presentationPart(slideCount)),
    'ppt/_rels/presentation.xml.rels': strToU8(presentationRelationships(slideCount)),
    'ppt/slideMasters/slideMaster1.xml': strToU8(slideMasterPart()),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(slideMasterRelationships()),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(slideLayoutPart()),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(slideLayoutRelationships()),
    'ppt/theme/theme1.xml': strToU8(themePart())
  }

  slides.forEach((slide, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(slide)
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(slideRelationships())
  })

  const bytes = zipSync(files, { level: 6, mtime: DECK_ENTRY_MTIME })

  return { ok: true, bytes, slideCount, sha256Input: JSON.stringify(input) }
}
