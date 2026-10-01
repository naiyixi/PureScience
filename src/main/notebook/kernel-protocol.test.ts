import { describe, expect, it } from 'vitest'

import {
  KERNEL_FIGURES_DIR_ENV,
  frameRRequest,
  framePythonRequest,
  parseLoopResponse
} from './kernel-protocol'

describe('parseLoopResponse', () => {
  it('parses the driver read report, and keeps an absent report absent', () => {
    const withReads = parseLoopResponse(
      JSON.stringify({
        req_id: 'r-reads',
        stdout: '',
        stderr: '',
        error: null,
        result: null,
        cwd: '/tmp/nb/data',
        figures: [],
        read_files: [
          { path: '/tmp/nb/data/in.csv', reads: 2 },
          { path: '/tmp/nb/data/other.csv', reads: 1 }
        ],
        read_files_truncated: 5
      })
    )
    expect(withReads?.readFiles).toEqual([
      { path: '/tmp/nb/data/in.csv', reads: 2 },
      { path: '/tmp/nb/data/other.csv', reads: 1 }
    ])
    expect(withReads?.readFilesTruncated).toBe(5)

    // No report at all (the R loop, or a driver that predates the capture) is NOT an empty report:
    // the field stays missing so the run record can say which driver could not report.
    const withoutReads = parseLoopResponse(
      JSON.stringify({
        req_id: 'r-2',
        stdout: '',
        stderr: '',
        error: null,
        result: null,
        cwd: '/tmp',
        figures: []
      })
    )
    expect(withoutReads).not.toHaveProperty('readFiles')
    expect(withoutReads).not.toHaveProperty('readFilesTruncated')

    // An empty report IS a report: it says the cell opened no file.
    const emptyReads = parseLoopResponse(
      JSON.stringify({
        req_id: 'r-3',
        stdout: '',
        stderr: '',
        error: null,
        result: null,
        cwd: '/tmp',
        figures: [],
        read_files: []
      })
    )
    expect(emptyReads?.readFiles).toEqual([])
  })

  it('carries whether an opened path was actually there', () => {
    const parsed = parseLoopResponse(
      JSON.stringify({
        req_id: 'r-present',
        stdout: '',
        stderr: '',
        error: null,
        result: null,
        cwd: '/tmp',
        figures: [],
        read_files: [
          { path: '/tmp/here.csv', reads: 1, present: true },
          { path: '/tmp/gone.csv', reads: 1, present: false },
          // A driver that predates the flag reports no `present`: the field stays absent so the
          // classifier can tell "unknown" from "was not there".
          { path: '/tmp/older.csv', reads: 1 }
        ]
      })
    )

    expect(parsed?.readFiles).toEqual([
      { path: '/tmp/here.csv', reads: 1, present: true },
      { path: '/tmp/gone.csv', reads: 1, present: false },
      { path: '/tmp/older.csv', reads: 1 }
    ])
  })

  it('drops unusable read entries instead of passing them through', () => {
    const parsed = parseLoopResponse(
      JSON.stringify({
        req_id: 'r-4',
        stdout: '',
        stderr: '',
        error: null,
        result: null,
        cwd: '/tmp',
        figures: [],
        read_files: [{ path: '', reads: 1 }, { reads: 3 }, { path: '/tmp/a.csv' }]
      })
    )

    // A path-less entry is not evidence of anything, and a missing count defaults to one open.
    expect(parsed?.readFiles).toEqual([{ path: '/tmp/a.csv', reads: 1 }])
  })

  it('parses a well-formed snake_case response line into camelCase', () => {
    const line = JSON.stringify({
      req_id: 'r1',
      stdout: 'hi',
      stderr: 'oops',
      error: null,
      result: '42',
      cwd: '/tmp/nb',
      figures: [{ mime: 'image/png', path: '/tmp/fig1.png' }],
      environment: {
        runtime_version: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            version_status: 'known',
            ecosystem: 'python',
            evidence_sources: ['python-kernel-modules'],
            loaded_state: 'loaded'
          }
        ]
      }
    })
    expect(parseLoopResponse(line)).toEqual({
      reqId: 'r1',
      stdout: 'hi',
      stderr: 'oops',
      error: null,
      errorLine: null,
      result: '42',
      cwd: '/tmp/nb',
      figures: [{ mime: 'image/png', path: '/tmp/fig1.png' }],
      environmentOverlay: {
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-kernel-modules'],
            loadedState: 'loaded'
          }
        ]
      }
    })
  })

  it('fills in safe defaults for missing fields', () => {
    const line = JSON.stringify({ req_id: 'r2' })
    expect(parseLoopResponse(line)).toEqual({
      reqId: 'r2',
      stdout: '',
      stderr: '',
      error: null,
      errorLine: null,
      result: null,
      cwd: '',
      figures: []
    })
  })

  it('parses error_line into errorLine when the loop attributes a source line', () => {
    const line = JSON.stringify({
      req_id: 'r4',
      error: "there is no package called 'ggrepel'",
      error_line: 7
    })
    expect(parseLoopResponse(line)?.errorLine).toBe(7)
  })

  it('leaves errorLine null when error_line is absent or non-numeric', () => {
    expect(parseLoopResponse(JSON.stringify({ req_id: 'r5', error: 'boom' }))?.errorLine).toBeNull()
    expect(
      parseLoopResponse(JSON.stringify({ req_id: 'r6', error_line: 'nope' }))?.errorLine
    ).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseLoopResponse('not json')).toBeNull()
  })

  it('returns null for a non-object JSON value', () => {
    expect(parseLoopResponse('42')).toBeNull()
    expect(parseLoopResponse('null')).toBeNull()
    expect(parseLoopResponse('[1,2,3]')).toBeNull()
  })

  it('ignores non-object entries within figures', () => {
    const line = JSON.stringify({
      req_id: 'r3',
      figures: [{ mime: 'image/png', path: '/f.png' }, 'garbage', 42, null]
    })
    expect(parseLoopResponse(line)?.figures).toEqual([{ mime: 'image/png', path: '/f.png' }])
  })
})

describe('framePythonRequest', () => {
  it('builds a stable-order JSON line terminated by newline', () => {
    expect(framePythonRequest('id', 'print(1)')).toBe('{"req_id":"id","code":"print(1)"}\n')
  })
})

describe('frameRRequest', () => {
  it('builds a length-prefixed header followed by the exact UTF-8 code bytes', () => {
    const code = 'x<-1'
    const buf = frameRRequest('id', code)
    const header = `id ${Buffer.byteLength(code, 'utf8')}\n`
    expect(buf.subarray(0, header.length).toString('utf8')).toBe(header)
    expect(buf.subarray(header.length).toString('utf8')).toBe(code)
    expect(buf.length).toBe(header.length + Buffer.byteLength(code, 'utf8'))
  })

  it('uses the UTF-8 byte length for multibyte code, not the string length', () => {
    // Multibyte (non-ASCII) content so UTF-8 byte length exceeds the JS string length.
    const code = '# café ☕\nx<-1'
    const buf = frameRRequest('id', code)
    const byteLen = Buffer.byteLength(code, 'utf8')
    expect(byteLen).not.toBe(code.length)
    const header = `id ${byteLen}\n`
    expect(buf.subarray(0, header.length).toString('utf8')).toBe(header)
    expect(buf.subarray(header.length).toString('utf8')).toBe(code)
    expect(buf.length).toBe(header.length + byteLen)
  })
})

describe('KERNEL_FIGURES_DIR_ENV', () => {
  it('is the stable env var name for the figures directory', () => {
    expect(KERNEL_FIGURES_DIR_ENV).toBe('PURESCIENCE_KERNEL_FIGURES_DIR')
  })
})
