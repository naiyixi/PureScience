// External-facing deck MCP server: build a real PresentationML file from an outline, and read one back.
//
// Why this one runs without the app: the deck writer (`./pptx-deck.ts`) is a pure function over an outline —
// no clock, no host name, fixed zip timestamps — so an external client (Claude Desktop, Cursor, a script) can
// produce a deck with nothing but the CLI. Making it reachable through the desktop bridge would have meant the
// app had to be open to write a file that needs none of its state.
//
// What this server does NOT do: edit an existing deck in place. Slide XML carries layout, images and theme
// references, and rewriting one paragraph while preserving the rest is a different piece of work. `pptx_read`
// exists so the honest path is available instead — read what is there, then build the deck you want.

import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { unzipSync, strFromU8 } from 'fflate'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

import {
  buildPptxDeck,
  validateDeckFilename,
  PPTX_DECK_MAX_BULLETS_PER_SECTION,
  PPTX_DECK_MAX_SECTIONS,
  PPTX_DECK_MAX_TEXT_CHARS,
  type PptxDeckInput,
  type PptxDeckRefusal
} from './pptx-deck'

export const PPTX_MCP_SERVER_NAME = 'purescience-pptx'
export const PPTX_MCP_SERVER_ARG = '--purescience-pptx-mcp'

export const PPTX_CREATE_TOOL = 'pptx_create'
export const PPTX_READ_TOOL = 'pptx_read'

const createSchema = {
  title: z.string().min(1).max(PPTX_DECK_MAX_TEXT_CHARS).describe('Deck title (the cover slide).'),
  subtitle: z
    .string()
    .max(PPTX_DECK_MAX_TEXT_CHARS)
    .optional()
    .describe('Optional cover subtitle.'),
  author: z
    .string()
    .max(512)
    .optional()
    .describe(
      'Written as the document author only when you have a real one. Never defaulted — a deck that names ' +
        'nobody is better than a deck that names the wrong person.'
    ),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(PPTX_DECK_MAX_TEXT_CHARS).describe('Slide heading.'),
        bullets: z
          .array(z.string().max(PPTX_DECK_MAX_TEXT_CHARS))
          .max(PPTX_DECK_MAX_BULLETS_PER_SECTION)
          .default([])
          .describe(`Body bullets (at most ${PPTX_DECK_MAX_BULLETS_PER_SECTION} per slide).`)
      })
    )
    .min(1)
    .max(PPTX_DECK_MAX_SECTIONS)
    .describe('One entry per content slide, in presentation order.'),
  outputPath: z
    .string()
    .min(1)
    .max(4096)
    .describe('Absolute path to write, ending in .pptx. Parent directories are created if missing.')
}

const readSchema = {
  path: z.string().min(1).max(4096).describe('Absolute path of a .pptx file to summarise.')
}

export type PptxMcpHandler = {
  create: (input: PptxDeckInput & { outputPath: string }) => Promise<
    | { ok: true; path: string; bytes: number; slideCount: number; sha256Input: string }
    | {
        ok: false
        refusal: PptxDeckRefusal | 'output-not-absolute' | 'output-not-pptx' | 'write-failed'
        detail: string
      }
  >
  read: (path: string) => Promise<
    | {
        ok: true
        path: string
        slideCount: number
        slides: { heading: string; bullets: string[] }[]
      }
    | { ok: false; refusal: 'not-a-pptx' | 'not-found' | 'unreadable'; detail: string }
  >
}

// Slide text lives in `<a:t>` runs. Paragraphs are the unit a reader perceives: one `<a:p>` per bullet (or
// per heading line), runs inside it concatenated, because a spell-checker-friendly writer splits a single
// sentence into many runs.
const PARAGRAPH = /<a:p>([\s\S]*?)<\/a:p>/gu
const TEXT_RUN = /<a:t>([\s\S]*?)<\/a:t>/gu
const SLIDE_ENTRY = /^ppt\/slides\/slide(\d+)\.xml$/u

const decodeXml = (value: string): string =>
  value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')

/** Every non-empty paragraph's text, in document order, with its runs joined. */
const paragraphsOf = (xml: string): string[] => {
  const out: string[] = []
  for (const paragraph of xml.matchAll(PARAGRAPH)) {
    const body = paragraph[1] ?? ''
    const text = [...body.matchAll(TEXT_RUN)].map((run) => decodeXml(run[1] ?? '')).join('')
    const trimmed = text.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

// Exported so the protocol tests drive the same handler the stdio server wires up: a test against a
// hand-rolled stub would prove the stub works.
export const createPptxHandler = (): PptxMcpHandler => ({
  create: async (input) => {
    if (!input.outputPath.startsWith('/')) {
      return {
        ok: false,
        refusal: 'output-not-absolute',
        detail:
          'Pass an absolute path — a relative one would resolve against the client’s cwd, not the user’s.'
      }
    }
    const filename = validateDeckFilename(input.outputPath.split('/').pop() ?? '')
    if (!filename.ok) {
      return {
        ok: false,
        refusal: 'output-not-pptx',
        detail: `${filename.detail} An output path has to be an absolute path ending in .pptx.`
      }
    }

    const deck = buildPptxDeck({
      title: input.title,
      sections: input.sections.map((section) => ({
        heading: section.heading,
        bullets: section.bullets
      })),
      ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
      ...(input.author === undefined ? {} : { author: input.author })
    })
    if (!deck.ok) return deck

    try {
      await mkdir(dirname(input.outputPath), { recursive: true })
      await writeFile(input.outputPath, deck.bytes)
    } catch (error) {
      return {
        ok: false,
        refusal: 'write-failed',
        detail: error instanceof Error ? error.message : String(error)
      }
    }

    return {
      ok: true,
      path: input.outputPath,
      bytes: deck.bytes.byteLength,
      slideCount: deck.slideCount,
      sha256Input: deck.sha256Input
    }
  },

  read: async (path) => {
    let bytes: Uint8Array
    try {
      bytes = await readFile(path)
    } catch (error) {
      const code = (error as { code?: string }).code
      return {
        ok: false,
        refusal: code === 'ENOENT' ? 'not-found' : 'unreadable',
        detail: code === 'ENOENT' ? `No file at ${path}.` : `Could not read ${path}.`
      }
    }

    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(bytes)
    } catch {
      return {
        ok: false,
        refusal: 'not-a-pptx',
        detail: `${path} is not a zip package, so it is not a PresentationML deck.`
      }
    }

    const slideEntries = Object.keys(files)
      .map((name) => ({ name, match: SLIDE_ENTRY.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
      .map((entry) => ({ name: entry.name, index: Number(entry.match[1]) }))
      .sort((a, b) => a.index - b.index)

    if (slideEntries.length === 0) {
      return {
        ok: false,
        refusal: 'not-a-pptx',
        detail: `${path} has no slides: a deck needs ppt/slides/slideN.xml parts.`
      }
    }

    return {
      ok: true,
      path,
      slideCount: slideEntries.length,
      slides: slideEntries.map((entry) => {
        const paragraphs = paragraphsOf(strFromU8(files[entry.name] as Uint8Array))
        return { heading: paragraphs[0] ?? '', bullets: paragraphs.slice(1) }
      })
    }
  }
})

// A refusal is data: an MCP client renders a thrown error as "tool failed" and loses the reason.
const asText = (payload: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
})

export const createPptxMcpServer = (handler: PptxMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({ name: PPTX_MCP_SERVER_NAME, version: '1.0.0' })

  server.registerTool(
    PPTX_CREATE_TOOL,
    {
      title: 'Build a .pptx deck',
      description:
        'Build a 16:9 PresentationML deck from an outline and write it to an absolute path. Returns the path, ' +
        'byte size and slide count. The bytes depend only on the outline (no clock, no host name), so the same ' +
        'outline always produces the same file. This builds a deck; it does not edit an existing one.',
      inputSchema: createSchema
    },
    async (input) => asText(await handler.create(input))
  )

  server.registerTool(
    PPTX_READ_TOOL,
    {
      title: 'Read a .pptx deck',
      description:
        'Summarise an existing deck: slide count and, per slide, its heading and bullets. Use this to see what ' +
        'a deck says before rebuilding it — this tool reads, it does not modify.',
      inputSchema: readSchema
    },
    async (input) => asText(await handler.read(input.path))
  )

  return server
}

/** Runs the server over stdio, the transport every external MCP client speaks to a child process. */
export const runPptxMcpServer = async (): Promise<void> => {
  const server = createPptxMcpServer(createPptxHandler())
  await server.connect(new StdioServerTransport())
}
