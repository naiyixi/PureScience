import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 as zlibCrc32 } from 'node:zlib'

const downloadsPath = join('/Users/example', 'Downloads')

const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
const getAppPath = vi.hoisted(() => vi.fn())
const showSaveDialog = vi.hoisted(() => vi.fn())
const showOpenDialog = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: getAppPath },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showOpenDialog, showSaveDialog },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const { registerFileSaveHandlers } = await import('./file-save')

const appActionExport = {
  suggestedName: 'crambin-view.png',
  mimeType: 'image/png',
  data: new ArrayBuffer(4),
  approval: {
    surface: 'structure-view' as const,
    action: 'export-view-image' as const,
    writes: [{ kind: 'image' as const, fileName: 'crambin-view.png', extension: 'png' }]
  }
}

describe('file save IPC handlers', () => {
  beforeEach(() => {
    handlers.clear()
    getAppPath.mockReset()
    getAppPath.mockReturnValue(downloadsPath)
    showOpenDialog.mockReset()
    showSaveDialog.mockReset()
  })

  it('asks the approval card before an app-action export, and writes nothing when it is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-refused-'))
    const destinationPath = join(root, 'refused.png')
    const approvalBroker = { request: vi.fn().mockResolvedValue('deny') }
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({ approvalBroker } as never)

    try {
      const result = await handlers.get('file:save-blob')!({ sender: {} }, appActionExport)

      // 拒绝的产物必须是「什么都没有」：不写文件、连保存对话框都不弹。
      // （注意这条用例的 event 是故意给的：拒绝发生在碰 event.sender **之前**。）
      expect(result).toEqual({ saved: false, refused: 'approval-denied' })
      expect(showSaveDialog).not.toHaveBeenCalled()
      await expect(readFile(destinationPath)).rejects.toThrow()
      // 卡面拿到的是**应用动作**那一段（不是连接器语），并且只给一次性的授予。
      expect(approvalBroker.request).toHaveBeenCalledTimes(1)
      expect(approvalBroker.request.mock.calls[0]?.[0]).toMatchObject({
        connector: 'structure-view',
        method: 'export-view-image',
        availableScopes: ['once'],
        appAction: { surface: 'structure-view', action: 'export-view-image' }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes the file once the card allows it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-allowed-'))
    const destinationPath = join(root, 'allowed.png')
    const approvalBroker = { request: vi.fn().mockResolvedValue('once') }
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({ approvalBroker } as never)

    try {
      const result = await handlers.get('file:save-blob')!({ sender: {} }, appActionExport)
      expect(result).toEqual({ saved: true, filePath: destinationPath })
      await expect(readFile(destinationPath)).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // ---- 导出带着这段区域的事实（D4「导出后标签仍在」）--------------------------------------
  // 判据是**写出来的字节**：独立走一遍块结构 + 用 node:zlib 的 crc32 核，而不是信实现自己的返回值。
  const pngChunkBytes = (type: string, payload: number[]): number[] => [
    (payload.length >>> 24) & 0xff,
    (payload.length >>> 16) & 0xff,
    (payload.length >>> 8) & 0xff,
    payload.length & 0xff,
    ...[...type].map((character) => character.charCodeAt(0)),
    ...payload,
    0,
    0,
    0,
    0
  ]

  const pngBytes = (): Uint8Array =>
    Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...pngChunkBytes('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
      ...pngChunkBytes('IDAT', [0x78, 0x9c]),
      ...pngChunkBytes('IEND', [])
    ])

  const readPngTextChunks = (
    bytes: Uint8Array
  ): { type: string; keyword: string; text: string }[] => {
    const found: { type: string; keyword: string; text: string }[] = []
    let offset = 8
    while (offset + 12 <= bytes.length) {
      const length =
        ((bytes[offset] << 24) |
          (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) |
          bytes[offset + 3]) >>>
        0
      const end = offset + 12 + length
      if (end > bytes.length) break
      const type = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7]
      )
      const stored =
        ((bytes[end - 4] << 24) |
          (bytes[end - 3] << 16) |
          (bytes[end - 2] << 8) |
          bytes[end - 1]) >>>
        0
      const body = Uint8Array.from([
        ...[...type].map((character) => character.charCodeAt(0)),
        ...bytes.subarray(offset + 8, offset + 8 + length)
      ])
      if (type === 'iTXt') {
        // 只核**写进去的那几块**的 CRC，且用 node:zlib 的独立实现核 —— 新增的块必须结构完好。
        // （夹具自带的几块用占位 CRC，就像共享层那支夹具一样；它们不是这轮要证明的东西。）
        expect(stored).toBe(zlibCrc32(body))
        const data = bytes.subarray(offset + 8, offset + 8 + length)
        const keywordEnd = data.indexOf(0)
        const languageEnd = data.indexOf(0, keywordEnd + 3)
        const translatedEnd = data.indexOf(0, languageEnd + 1)
        found.push({
          type,
          keyword: Buffer.from(data.subarray(0, keywordEnd)).toString('latin1'),
          text: new TextDecoder().decode(data.subarray(translatedEnd + 1))
        })
      }
      offset = end
    }
    return found
  }

  it('writes the marked region and its name into the exported PNG', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-facts-'))
    const destinationPath = join(root, 'marked.png')
    const source = pngBytes()
    const approvalBroker = { request: vi.fn().mockResolvedValue('once') }
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({ approvalBroker } as never)

    try {
      const result = await handlers.get('file:save-blob')!(
        { sender: {} },
        {
          ...appActionExport,
          data: source.buffer.slice(0) as ArrayBuffer,
          imageFacts: [
            { keyword: 'PureScience-Region', text: 'structure-selection:v2-3f2a1b0c' },
            { keyword: 'PureScience-Label', text: '活性位点' }
          ]
        }
      )

      expect(result).toEqual({ saved: true, filePath: destinationPath, factsEmbedded: true })
      const written = new Uint8Array(await readFile(destinationPath))
      // 文件里真的有这两条事实，而且中文名字逐字回得来。
      expect(readPngTextChunks(written)).toEqual([
        { type: 'iTXt', keyword: 'PureScience-Region', text: 'structure-selection:v2-3f2a1b0c' },
        { type: 'iTXt', keyword: 'PureScience-Label', text: '活性位点' }
      ])
      // 只加了元数据：原图那几块一个字节没动。
      expect([...written.subarray(0, 8)]).toEqual([...source.subarray(0, 8)])
      expect([...written.subarray(written.length - 12)]).toEqual([
        ...source.subarray(source.length - 12)
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('says so when the marked region cannot be written into the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-no-facts-'))
    const destinationPath = join(root, 'not-a-png.png')
    // 声明的 MIME 说是 PNG，字节却不是 ⇒ 不许硬塞，也不许把「我以为写了」说成「文件里有」。
    const notPng = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04])
    const approvalBroker = { request: vi.fn().mockResolvedValue('once') }
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({ approvalBroker } as never)

    try {
      const result = await handlers.get('file:save-blob')!(
        { sender: {} },
        {
          ...appActionExport,
          data: notPng.buffer.slice(0) as ArrayBuffer,
          imageFacts: [{ keyword: 'PureScience-Region', text: 'structure-selection:v2-x' }]
        }
      )

      // 导出**成功**（文件是好的），但如实回一句「事实没写进去」。
      expect(result).toEqual({ saved: true, filePath: destinationPath, factsEmbedded: false })
      expect([...(await readFile(destinationPath))]).toEqual([...notPng])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never asks the card for an ordinary save, and refuses a gated save with no card wired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-ordinary-'))
    const destinationPath = join(root, 'ordinary.png')
    const approvalBroker = { request: vi.fn().mockResolvedValue('once') }
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({ approvalBroker } as never)

    try {
      // 普通保存（不带 approval 标记）走过门而不问卡：既有行为逐字节不变。
      const ordinary = await handlers.get('file:save-blob')!(
        { sender: {} },
        {
          suggestedName: 'ordinary.png',
          mimeType: 'image/png',
          data: new ArrayBuffer(4)
        }
      )
      expect(ordinary).toEqual({ saved: true, filePath: destinationPath })
      expect(approvalBroker.request).not.toHaveBeenCalled()

      // 带标记但没有卡片可问 ⇒ 拒（fail-closed）：「没人能被问」不能读成「没问题」。
      showSaveDialog.mockClear()
      registerFileSaveHandlers({} as never)
      const gated = await handlers.get('file:save-blob')!(
        { sender: {} },
        {
          ...appActionExport,
          suggestedName: 'gated.png'
        }
      )
      expect(gated).toEqual({ saved: false, refused: 'approval-denied' })
      expect(showSaveDialog).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exports one selected Session Artifact through Save As', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-session-artifact-'))
    const sourcePath = join(root, 'managed-report.csv')
    const destinationPath = join(root, 'downloaded-report.csv')
    await writeFile(sourcePath, 'artifact bytes')
    const resolveSessionArtifactFilePath = vi.fn().mockResolvedValue(sourcePath)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destinationPath })
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-session-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          files: [{ path: 'artifact://report', suggestedName: 'report.csv' }]
        }
      )

      expect(resolveSessionArtifactFilePath).toHaveBeenCalledWith(
        'project-1',
        'session-1',
        'artifact://report'
      )
      expect(showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: join(downloadsPath, 'report.csv'),
          title: 'Save artifact'
        })
      )
      expect(result).toEqual({ saved: true, filePaths: [destinationPath] })
      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('artifact bytes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exports multiple selected Session Artifacts after choosing one destination folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-session-artifacts-'))
    const sourceA = join(root, 'managed-a.csv')
    const sourceB = join(root, 'managed-b.png')
    const destinationDirectory = join(root, 'downloads')
    await writeFile(sourceA, 'artifact a')
    await writeFile(sourceB, 'artifact b')
    await mkdir(destinationDirectory)
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(sourceA)
      .mockResolvedValueOnce(sourceB)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-session-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          files: [
            { path: 'artifact://a', suggestedName: 'a.csv' },
            { path: 'artifact://b', suggestedName: 'b.png' }
          ]
        }
      )

      expect(showOpenDialog).toHaveBeenCalledTimes(1)
      expect(showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: downloadsPath,
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose where to save artifacts'
        })
      )
      expect(result).toEqual({
        saved: true,
        filePaths: [join(destinationDirectory, 'a.csv'), join(destinationDirectory, 'b.png')]
      })
      await expect(readFile(join(destinationDirectory, 'a.csv'), 'utf8')).resolves.toBe(
        'artifact a'
      )
      await expect(readFile(join(destinationDirectory, 'b.png'), 'utf8')).resolves.toBe(
        'artifact b'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps existing files and selected duplicate names when exporting multiple Artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-artifact-collisions-'))
    const sourceA = join(root, 'managed-a.csv')
    const sourceB = join(root, 'managed-b.csv')
    const destinationDirectory = join(root, 'downloads')
    await writeFile(sourceA, 'artifact a')
    await writeFile(sourceB, 'artifact b')
    await mkdir(destinationDirectory)
    await writeFile(join(destinationDirectory, 'report.csv'), 'existing download')
    const resolveSessionArtifactFilePath = vi
      .fn()
      .mockResolvedValueOnce(sourceA)
      .mockResolvedValueOnce(sourceB)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({ resolveSessionArtifactFilePath } as never)

    try {
      const result = await handlers.get('file:save-session-artifacts')!(
        { sender: {} },
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          files: [
            { path: 'artifact://a', suggestedName: 'report.csv' },
            { path: 'artifact://b', suggestedName: 'report.csv' }
          ]
        }
      )

      expect(result).toEqual({
        saved: true,
        filePaths: [
          join(destinationDirectory, 'report (2).csv'),
          join(destinationDirectory, 'report (3).csv')
        ]
      })
      await expect(readFile(join(destinationDirectory, 'report.csv'), 'utf8')).resolves.toBe(
        'existing download'
      )
      await expect(readFile(join(destinationDirectory, 'report (2).csv'), 'utf8')).resolves.toBe(
        'artifact a'
      )
      await expect(readFile(join(destinationDirectory, 'report (3).csv'), 'utf8')).resolves.toBe(
        'artifact b'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports one failed Artifact while keeping the other batch exports', async () => {
    const destinationDirectory = '/downloads/session-artifacts'
    const closeA = vi.fn().mockResolvedValue(undefined)
    const closeB = vi.fn().mockResolvedValue(undefined)
    const copyA = vi.fn().mockResolvedValue(undefined)
    const copyB = vi.fn().mockRejectedValue(new Error('disk full'))
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({
      resolveSessionArtifactFilePath: vi
        .fn()
        .mockResolvedValueOnce('/managed/a.csv')
        .mockResolvedValueOnce('/managed/b.csv'),
      openManagedFile: vi
        .fn()
        .mockResolvedValueOnce({ copyTo: copyA, close: closeA })
        .mockResolvedValueOnce({ copyTo: copyB, close: closeB })
    } as never)

    const result = await handlers.get('file:save-session-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        files: [
          { path: 'artifact://a', suggestedName: 'a.csv' },
          { path: 'artifact://b', suggestedName: 'b.csv' }
        ]
      }
    )

    expect(result).toEqual({
      saved: true,
      filePaths: [join(destinationDirectory, 'a.csv')],
      failures: [
        {
          path: 'artifact://b',
          suggestedName: 'b.csv',
          message: 'disk full'
        }
      ]
    })
    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeB).toHaveBeenCalledTimes(1)
  })

  it('keeps exporting valid Artifacts when one selected source no longer resolves', async () => {
    const destinationDirectory = '/downloads/session-artifacts'
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destinationDirectory] })
    registerFileSaveHandlers({
      resolveSessionArtifactFilePath: vi
        .fn()
        .mockRejectedValueOnce(new Error('Artifact no longer exists'))
        .mockResolvedValueOnce('/managed/b.csv'),
      openManagedFile: vi.fn().mockResolvedValue({ copyTo, close })
    } as never)

    const result = await handlers.get('file:save-session-artifacts')!(
      { sender: {} },
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        files: [
          { path: 'artifact://missing', suggestedName: 'missing.csv' },
          { path: 'artifact://b', suggestedName: 'b.csv' }
        ]
      }
    )

    expect(result).toEqual({
      saved: true,
      filePaths: [join(destinationDirectory, 'b.csv')],
      failures: [
        {
          path: 'artifact://missing',
          suggestedName: 'missing.csv',
          message: 'Artifact no longer exists'
        }
      ]
    })
    expect(copyTo).toHaveBeenCalledWith(join(destinationDirectory, 'b.csv'), { exclusive: true })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('registers a managed-file save channel', () => {
    registerFileSaveHandlers()

    expect(handlers.has('file:save-managed')).toBe(true)
  })

  it('opens a managed source once and copies that exact file to the selected destination', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/canonical-report.csv')
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openManagedFile = vi.fn().mockResolvedValue({ copyTo, close })
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'report.csv')
    })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile
    })

    const result = await handlers.get('file:save-managed')!(
      { sender: {} },
      {
        source: 'upload',
        path: '/managed/requested-report.csv',
        suggestedName: '../report.csv'
      }
    )

    expect(resolveManagedFilePath).toHaveBeenCalledWith('upload', {
      path: '/managed/requested-report.csv'
    })
    expect(openManagedFile).toHaveBeenCalledWith('/managed/canonical-report.csv')
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: join(downloadsPath, 'report.csv') })
    )
    expect(copyTo).toHaveBeenCalledWith(join(downloadsPath, 'report.csv'))
    expect(close).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      saved: true,
      filePath: join(downloadsPath, 'report.csv')
    })
  })

  it('accepts a local source and saves through the same managed pipeline', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/Users/example/logs/proxy.log')
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openManagedFile = vi.fn().mockResolvedValue({ copyTo, close })
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'proxy.log')
    })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile
    })

    const result = await handlers.get('file:save-managed')!(
      { sender: {} },
      {
        source: 'local',
        path: '/Users/example/logs/proxy.log',
        suggestedName: 'proxy.log'
      }
    )

    expect(resolveManagedFilePath).toHaveBeenCalledWith('local', {
      path: '/Users/example/logs/proxy.log'
    })
    expect(copyTo).toHaveBeenCalledWith(join(downloadsPath, 'proxy.log'))
    expect(close).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      saved: true,
      filePath: join(downloadsPath, 'proxy.log')
    })
  })

  it('copies the original pending file identity after it is finalized during Save As', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/.pending/report.csv')
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openManagedFile = vi.fn().mockResolvedValue({ copyTo, close })
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'report.csv')
    })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile
    })

    await handlers.get('file:save-managed')!(
      { sender: {} },
      { source: 'artifact', path: 'session/report.csv', suggestedName: 'report.csv' }
    )

    expect(resolveManagedFilePath).toHaveBeenCalledTimes(1)
    expect(copyTo).toHaveBeenCalledWith(join(downloadsPath, 'report.csv'))
    expect(openManagedFile).toHaveBeenCalledWith('/managed/.pending/report.csv')
  })

  it('keeps copying the same real file handle when its source path is renamed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-'))
    const pendingPath = join(root, 'pending-report.csv')
    const finalizedPath = join(root, 'final-report.csv')
    const destinationPath = join(root, 'downloaded-report.csv')
    await writeFile(pendingPath, 'stable artifact bytes')
    const resolveManagedFilePath = vi.fn().mockResolvedValue(pendingPath)
    showSaveDialog.mockImplementation(async () => {
      await rename(pendingPath, finalizedPath)
      return { canceled: false, filePath: destinationPath }
    })
    registerFileSaveHandlers({ resolveManagedFilePath })

    try {
      await handlers.get('file:save-managed')!(
        { sender: {} },
        { source: 'artifact', path: pendingPath, suggestedName: 'report.csv' }
      )

      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('stable artifact bytes')
      await expect(readFile(finalizedPath, 'utf8')).resolves.toBe('stable artifact bytes')
      expect(resolveManagedFilePath).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not truncate a managed file when Save As selects the source itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-source-'))
    const sourcePath = join(root, 'report.csv')
    await writeFile(sourcePath, 'source must survive')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: sourcePath })
    registerFileSaveHandlers({
      resolveManagedFilePath: vi.fn().mockResolvedValue(sourcePath)
    })

    try {
      await expect(
        handlers.get('file:save-managed')!(
          { sender: {} },
          { source: 'artifact', path: sourcePath, suggestedName: 'report.csv' }
        )
      ).rejects.toThrow('Cannot save a managed file over its source.')
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe('source must survive')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps traversal-only suggested names inside Downloads', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/source-report.csv')
    showSaveDialog.mockResolvedValue({ canceled: true })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile: vi.fn().mockResolvedValue({
        copyTo: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      })
    } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      { source: 'upload', path: '/managed/source-report.csv', suggestedName: '..' }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: join(downloadsPath, 'source-report.csv')
      })
    )
  })

  it('rejects malformed requests before resolving or prompting', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/report.csv')
    registerFileSaveHandlers({ resolveManagedFilePath } as never)

    await expect(
      handlers.get('file:save-managed')!(
        { sender: {} },
        {
          source: 'workspace',
          path: '/outside/report.csv',
          suggestedName: 'report.csv'
        }
      )
    ).rejects.toThrow('Invalid managed file save request.')

    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('returns without copying when the save dialog is canceled', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/report.csv')
    const copyTo = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openManagedFile = vi.fn().mockResolvedValue({
      copyTo,
      close
    })
    showSaveDialog.mockResolvedValue({ canceled: true })
    registerFileSaveHandlers({ resolveManagedFilePath, openManagedFile } as never)

    const result = await handlers.get('file:save-managed')!(
      { sender: {} },
      { source: 'artifact', path: '/managed/report.csv', suggestedName: 'report.csv' }
    )

    expect(result).toEqual({ saved: false })
    expect(openManagedFile).toHaveBeenCalledWith('/managed/report.csv')
    expect(copyTo).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the managed file handle when copying fails', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/report.csv')
    const copyTo = vi.fn().mockRejectedValue(new Error('disk full'))
    const close = vi.fn().mockResolvedValue(undefined)
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(downloadsPath, 'report.csv')
    })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile: vi.fn().mockResolvedValue({ copyTo, close })
    } as never)

    await expect(
      handlers.get('file:save-managed')!(
        { sender: {} },
        { source: 'artifact', path: '/managed/report.csv', suggestedName: 'report.csv' }
      )
    ).rejects.toThrow('disk full')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not prompt when managed path validation fails', async () => {
    const resolveManagedFilePath = vi.fn().mockRejectedValue(new Error('outside artifact storage'))
    registerFileSaveHandlers({ resolveManagedFilePath } as never)

    await expect(
      handlers.get('file:save-managed')!(
        { sender: {} },
        { source: 'artifact', path: '/outside/report.csv', suggestedName: 'report.csv' }
      )
    ).rejects.toThrow('outside artifact storage')

    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('throws when no managed file resolver is configured', async () => {
    registerFileSaveHandlers()

    await expect(
      handlers.get('file:save-managed')!(
        { sender: {} },
        { source: 'artifact', path: '/managed/report.csv', suggestedName: 'report.csv' }
      )
    ).rejects.toThrow('Managed file resolver is not configured.')

    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('falls back to the source basename when suggestedName is a single dot', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/source-report.csv')
    showSaveDialog.mockResolvedValue({ canceled: true })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile: vi.fn().mockResolvedValue({
        copyTo: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      })
    } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      { source: 'upload', path: '/managed/source-report.csv', suggestedName: '.' }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: join(downloadsPath, 'source-report.csv')
      })
    )
  })

  it('falls back to the source basename when suggestedName is whitespace only', async () => {
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/source-report.csv')
    showSaveDialog.mockResolvedValue({ canceled: true })
    registerFileSaveHandlers({
      resolveManagedFilePath,
      openManagedFile: vi.fn().mockResolvedValue({
        copyTo: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      })
    } as never)

    await handlers.get('file:save-managed')!(
      { sender: {} },
      { source: 'upload', path: '/managed/source-report.csv', suggestedName: '   ' }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: join(downloadsPath, 'source-report.csv')
      })
    )
  })
})

describe('file save blob handler', () => {
  beforeEach(() => {
    handlers.clear()
    showSaveDialog.mockReset()
    registerFileSaveHandlers()
  })

  it('registers the file:save-blob channel', () => {
    expect(handlers.has('file:save-blob')).toBe(true)
  })

  it('returns {saved:false} when the dialog is canceled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })

    const result = await handlers.get('file:save-blob')!(
      { sender: {} },
      {
        suggestedName: 'image.png',
        mimeType: 'image/png',
        data: new ArrayBuffer(0)
      }
    )

    expect(result).toEqual({ saved: false })
  })

  it('writes the blob bytes to the chosen destination and returns the path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-save-blob-'))
    const destination = join(root, 'export.png')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })

    try {
      const result = await handlers.get('file:save-blob')!(
        { sender: {} },
        {
          suggestedName: 'image.png',
          mimeType: 'image/png',
          data: new TextEncoder().encode('hello-blob').buffer
        }
      )

      expect(result).toEqual({ saved: true, filePath: destination })
      expect(showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: 'image.png',
          filters: [{ name: 'PNG', extensions: ['png'] }]
        })
      )
      await expect(readFile(destination, 'utf8')).resolves.toBe('hello-blob')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps image/svg+xml to the svg extension filter', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'icon.svg', mimeType: 'image/svg+xml', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'SVG', extensions: ['svg'] }]
      })
    )
  })

  it.each([
    ['text/x-python', 'script.py', 'PY', 'py'],
    ['text/x-r', 'script.R', 'R', 'R'],
    ['text/x-sh', 'script.sh', 'SH', 'sh'],
    ['text/plain', 'notes.txt', 'TXT', 'txt']
  ])('maps %s to the %s extension filter', async (mimeType, suggestedName, name, extension) => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName, mimeType, data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name, extensions: [extension] }] })
    )
  })

  it('maps text/csv to the csv extension filter', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'data.csv', mimeType: 'text/csv', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
    )
  })

  it('maps text/tab-separated-values to the tsv extension filter', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'data.tsv', mimeType: 'text/tab-separated-values', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'TSV', extensions: ['tsv'] }]
      })
    )
  })

  it('maps text/markdown to the md extension filter', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'README.md', mimeType: 'text/markdown', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'MD', extensions: ['md'] }]
      })
    )
  })

  it('omits the file-type filter for unrecognised mime types', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await handlers.get('file:save-blob')!(
      { sender: {} },
      { suggestedName: 'data.bin', mimeType: 'application/octet-stream', data: new ArrayBuffer(0) }
    )

    expect(showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ filters: undefined }))
  })
})

describe('assertSaveManagedFileRequest validation paths', () => {
  beforeEach(() => {
    handlers.clear()
    showSaveDialog.mockReset()
  })

  const reject = async (request: unknown, label: string): Promise<void> => {
    registerFileSaveHandlers({
      resolveManagedFilePath: vi.fn().mockResolvedValue('/managed/report.csv'),
      openManagedFile: vi.fn().mockResolvedValue({
        copyTo: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      })
    } as never)

    await expect(handlers.get('file:save-managed')!({ sender: {} }, request)).rejects.toThrow(
      'Invalid managed file save request.'
    )

    expect(showSaveDialog).not.toHaveBeenCalled()
    // Helps narrow the failure source when a test unexpectedly passes.
    expect(label.length).toBeGreaterThan(0)
  }

  it('rejects a non-object request (e.g. a string)', async () => {
    await reject('not an object', 'string-request')
  })

  it('rejects a null request', async () => {
    await reject(null, 'null-request')
  })

  it('rejects an unsupported source enum value', async () => {
    await reject(
      { source: 'workspace', path: '/managed/report.csv', suggestedName: 'report.csv' },
      'bad-source'
    )
  })

  it('rejects a missing path', async () => {
    await reject({ source: 'artifact', suggestedName: 'report.csv' }, 'missing-path')
  })

  it('rejects a non-string path', async () => {
    await reject({ source: 'artifact', path: 42, suggestedName: 'report.csv' }, 'numeric-path')
  })

  it('rejects an empty path', async () => {
    await reject({ source: 'artifact', path: '', suggestedName: 'report.csv' }, 'empty-path')
  })

  it('rejects a whitespace-only path', async () => {
    await reject(
      { source: 'artifact', path: '   ', suggestedName: 'report.csv' },
      'whitespace-path'
    )
  })

  it('rejects a missing suggestedName', async () => {
    await reject({ source: 'artifact', path: '/managed/report.csv' }, 'missing-suggested-name')
  })

  it('rejects a non-string suggestedName', async () => {
    await reject(
      { source: 'artifact', path: '/managed/report.csv', suggestedName: 7 },
      'numeric-suggested-name'
    )
  })
})
