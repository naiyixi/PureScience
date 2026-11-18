// Protocol-level tests: a real MCP client, a real in-memory transport, real files on disk. The server is the
// thing under test — asserting against the handler would not prove a client can reach it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { unzipSync } from 'fflate'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createPptxHandler,
  createPptxMcpServer,
  PPTX_CREATE_TOOL,
  PPTX_READ_TOOL
} from './mcp-server'

type Payload = Record<string, unknown>

const connect = async (): Promise<Client> => {
  const server = createPptxMcpServer(createPptxHandler())
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'pptx-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

const textOf = (result: unknown): Payload => {
  const content = (result as { content?: { text?: string }[] }).content ?? []
  return JSON.parse(content.map((part) => part.text ?? '').join('')) as Payload
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pptx-mcp-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('deck MCP server', () => {
  it('builds a deck a real reader can open, and reads it back', async () => {
    const client = await connect()
    const path = join(dir, 'nested', 'deeper', 'deck.pptx')

    const created = textOf(
      await client.callTool({
        name: PPTX_CREATE_TOOL,
        arguments: {
          title: '中文演示文稿',
          subtitle: '外部客户端生成',
          author: '张三',
          sections: [
            { heading: '背景', bullets: ['深度学习在影像学中的应用', '数据规模决定上限'] },
            { heading: '方法', bullets: ['端到端训练', '多中心验证'] }
          ],
          outputPath: path
        }
      })
    )

    expect(created).toMatchObject({ ok: true, path, slideCount: 3 })
    expect(Number(created.bytes)).toBeGreaterThan(1000)
    // Parent directories were created, and the file is really on disk.
    expect(statSync(path).size).toBe(Number(created.bytes))

    // The package is a zip with the parts PresentationML requires. Listed through the zip reader the
    // platform already ships with (fflate) rather than a shelled-out `unzip`: that tool does not exist on
    // every host, and the property under test is the archive's contents, not the lister.
    const listing = Object.keys(unzipSync(readFileSync(path))).join('\n')
    expect(listing).toContain('ppt/presentation.xml')
    expect(listing).toContain('ppt/slides/slide3.xml')

    const readBack = textOf(await client.callTool({ name: PPTX_READ_TOOL, arguments: { path } }))
    expect(readBack).toMatchObject({ ok: true, path, slideCount: 3 })
    const slides = readBack.slides as { heading: string; bullets: string[] }[]
    expect(slides[0]?.heading).toBe('中文演示文稿')
    expect(slides[1]).toEqual({
      heading: '背景',
      bullets: ['深度学习在影像学中的应用', '数据规模决定上限']
    })
    expect(slides[2]?.heading).toBe('方法')
  })

  // A drive-letter path is absolute on Windows and not on POSIX, so the check has to follow the host's
  // rules. Pinned where it can actually fail: the check used to be `startsWith('/')`, which refused every
  // Windows path — the tool could not write a deck on that platform at all.
  it.runIf(process.platform === 'win32')('accepts a drive-letter output path', async () => {
    const client = await connect()
    const path = join(dir, 'drive.pptx')

    const created = textOf(
      await client.callTool({
        name: PPTX_CREATE_TOOL,
        arguments: { title: 'T', sections: [{ heading: 'H' }], outputPath: path }
      })
    )

    expect(created).toMatchObject({ ok: true, path })
    expect(statSync(path).size).toBeGreaterThan(1000)
  })

  it('produces the same bytes for the same outline, and different bytes when one bullet changes', async () => {
    const client = await connect()
    const first = join(dir, 'a.pptx')
    const second = join(dir, 'b.pptx')
    const outline = { title: '确定性', sections: [{ heading: '一', bullets: ['甲', '乙'] }] }

    await client.callTool({ name: PPTX_CREATE_TOOL, arguments: { ...outline, outputPath: first } })
    await client.callTool({ name: PPTX_CREATE_TOOL, arguments: { ...outline, outputPath: second } })
    expect(readFileSync(first).equals(readFileSync(second))).toBe(true)

    const changed = join(dir, 'c.pptx')
    await client.callTool({
      name: PPTX_CREATE_TOOL,
      arguments: {
        ...outline,
        sections: [{ heading: '一', bullets: ['甲', '丙'] }],
        outputPath: changed
      }
    })
    expect(readFileSync(first).equals(readFileSync(changed))).toBe(false)
  })

  it('refuses a relative path, a non-pptx name, and an empty outline — as data, not as a throw', async () => {
    const client = await connect()

    const relative = textOf(
      await client.callTool({
        name: PPTX_CREATE_TOOL,
        arguments: { title: 'T', sections: [{ heading: 'H' }], outputPath: 'deck.pptx' }
      })
    )
    expect(relative).toMatchObject({ ok: false, refusal: 'output-not-absolute' })

    const wrongExtension = textOf(
      await client.callTool({
        name: PPTX_CREATE_TOOL,
        arguments: { title: 'T', sections: [{ heading: 'H' }], outputPath: join(dir, 'deck.key') }
      })
    )
    expect(wrongExtension).toMatchObject({ ok: false, refusal: 'output-not-pptx' })

    // The writer's own refusals reach the client unchanged: a deck with no sections is refused, not written
    // as a cover-only file that looks like an empty deck.
    const noSections = await client.callTool({
      name: PPTX_CREATE_TOOL,
      arguments: { title: 'T', sections: [], outputPath: join(dir, 'empty.pptx') }
    })
    expect(noSections.isError).toBe(true)
  })

  it('reports a missing file and a non-zip file as named refusals', async () => {
    const client = await connect()

    const missing = textOf(
      await client.callTool({ name: PPTX_READ_TOOL, arguments: { path: join(dir, 'nope.pptx') } })
    )
    expect(missing).toMatchObject({ ok: false, refusal: 'not-found' })

    const fake = join(dir, 'fake.pptx')
    writeFileSync(fake, 'not a zip at all')
    const notZip = textOf(
      await client.callTool({ name: PPTX_READ_TOOL, arguments: { path: fake } })
    )
    expect(notZip).toMatchObject({ ok: false, refusal: 'not-a-pptx' })
  })
})
