// A verification script, not product code: drives the deck MCP server the way an external client does — a
// real child process over stdio — then proves the file opens with a reader we did not write.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const outDir = process.argv[2] ?? (await mkdtemp(join(tmpdir(), 'pptx-verify-')))
const outputPath = join(outDir, 'nested', 'deepseek-eval-deck.pptx')

const transport = new StdioClientTransport({
  command: 'node_modules/.bin/electron',
  args: ['out/main/index.js', '--purescience-pptx-mcp'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stderr: 'pipe'
})
const client = new Client({ name: 'pptx-verify', version: '0.0.0' })
await client.connect(transport)

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  return JSON.parse((result.content ?? []).map((part) => part.text ?? '').join(''))
}

const report = (label, value) =>
  console.log(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}`)

try {
  const tools = await client.listTools()
  report(
    'tools/list',
    tools.tools.map((tool) => tool.name)
  )

  const created = await call('pptx_create', {
    title: '国产大模型评测方法论',
    subtitle: '外部 MCP 客户端生成',
    author: 'Able',
    sections: [
      {
        heading: '为什么重做评测',
        bullets: ['公开榜单与真实任务分布不一致', '中文语料占比被系统性低估']
      },
      { heading: '评测集设计', bullets: ['按任务族分层抽样', '每题标注可核验的参考答案'] },
      { heading: '结论', bullets: ['同一模型在中文医学问答上差 11 个百分点'] }
    ],
    outputPath
  })
  report('pptx_create', created)

  if (created.ok !== true) throw new Error(`create refused: ${JSON.stringify(created)}`)

  const size = (await stat(outputPath)).size
  report('file on disk', { path: outputPath, bytes: size, matchesReported: size === created.bytes })

  const readBack = await call('pptx_read', { path: outputPath })
  report('pptx_read', readBack)

  // Two readers we did not write. First macOS Quick Look, which renders the package the way Finder does:
  // if it produces a thumbnail, the system considers this a real presentation. Then the renderer the app
  // itself depends on, loaded through its published CommonJS entry.
  const qlDir = join(outDir, 'quicklook')
  // qlmanage writes into a directory that must already exist; without it the run reports success and writes
  // nothing, which is indistinguishable from "this file cannot be previewed".
  await mkdir(qlDir, { recursive: true })
  const ql = await run('qlmanage', ['-t', '-s', '800', '-o', qlDir, outputPath]).catch((error) => ({
    stdout: String(error),
    stderr: ''
  }))
  const qlFiles = await readdir(qlDir).catch(() => [])
  const thumbnail = qlFiles.find((name) => name.endsWith('.png'))
  const thumbnailBytes = thumbnail === undefined ? 0 : (await stat(join(qlDir, thumbnail))).size
  report('macOS Quick Look', {
    producedThumbnail: thumbnail !== undefined,
    thumbnailBytes,
    stderr: ql.stderr.trim().slice(0, 160)
  })

  // The renderer the app itself depends on, through its published entry: it parses the package into its own
  // slide/layout/master maps. A writer that emitted bytes nothing can parse fails here even though the zip
  // looked fine.
  const rendered = await run('node', [
    '-e',
    `const api = require('@aiden0z/pptx-renderer');
     const fs = require('node:fs');
     api.parseZip(fs.readFileSync(${JSON.stringify(outputPath)})).then((p) => {
       const size = (v) => (v instanceof Map ? v.size : Array.isArray(v) ? v.length : null);
       console.log(JSON.stringify({ slides: size(p.slides), layouts: size(p.slideLayouts), masters: size(p.slideMasters) }));
     }).catch((e) => console.log(JSON.stringify({ error: String(e).slice(0, 200) })));`
  ]).catch((error) => ({ stdout: JSON.stringify({ error: String(error).slice(0, 200) }) }))
  report('app renderer (parseZip)', JSON.parse(rendered.stdout.trim()))
} finally {
  await client.close()
  if (process.argv[2] === undefined) await rm(outDir, { recursive: true, force: true })
}
