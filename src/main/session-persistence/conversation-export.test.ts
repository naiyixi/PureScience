import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'

const { fromWebContents, ipcHandlers } = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { fromWebContents }),
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandlers.set(channel, handler)
  }
}))

import {
  createConversationExportService,
  registerConversationExportIpcHandler
} from './conversation-export'

const session: PersistedChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Export test',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'message-1',
      role: 'user',
      content: 'Hello',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ],
  createdAt: 1,
  updatedAt: 2
}

describe('conversation export service', () => {
  const loadSession = vi.fn()
  const isSessionActive = vi.fn()
  const showSaveDialog = vi.fn()
  const writeExportFile = vi.fn()
  const createTempDirectory = vi.fn()
  const removeDirectory = vi.fn()
  const executeJavaScript = vi.fn()
  const printToPDF = vi.fn()
  const loadFile = vi.fn()
  const destroy = vi.fn()
  const createPrintWindow = vi.fn(() => ({
    loadFile,
    webContents: { executeJavaScript, printToPDF },
    destroy
  }))

  beforeEach(() => {
    vi.clearAllMocks()
    loadSession.mockResolvedValue(session)
    isSessionActive.mockReturnValue(false)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/export.md' })
    writeExportFile.mockResolvedValue(undefined)
    createTempDirectory.mockResolvedValue('/tmp/purescience-conversation-export-test')
    removeDirectory.mockResolvedValue(undefined)
    loadFile.mockResolvedValue(undefined)
    executeJavaScript.mockResolvedValue(true)
    printToPDF.mockResolvedValue(Buffer.from('pdf'))
  })

  const createService = (): ReturnType<typeof createConversationExportService> =>
    createConversationExportService({
      loadSession,
      isSessionActive,
      showSaveDialog,
      writeFile: writeExportFile,
      createTempDirectory,
      removeDirectory,
      createPrintWindow,
      getDownloadsPath: () => '/downloads',
      getTempPath: () => '/tmp',
      now: () => 3
    })

  it('loads the durable session and saves normalized Markdown', async () => {
    const result = await createService().exportConversation({
      projectId: 'project-1',
      sessionId: 'session-1',
      format: 'markdown'
    })

    expect(loadSession).toHaveBeenCalledWith('project-1', 'session-1')
    expect(showSaveDialog).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        defaultPath: join('/downloads', 'Export test.md'),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
    )
    expect(writeExportFile).toHaveBeenCalledWith(
      '/downloads/export.md',
      expect.stringContaining('# Export test')
    )
    expect(createPrintWindow).not.toHaveBeenCalled()
    expect(result).toEqual({ saved: true, filePath: '/downloads/export.md' })
  })

  it('prints dedicated HTML to PDF and always destroys the hidden window', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/export.pdf' })

    const result = await createService().exportConversation({
      projectId: 'project-1',
      sessionId: 'session-1',
      format: 'pdf'
    })

    expect(createTempDirectory).toHaveBeenCalledWith(
      join('/tmp', 'purescience-conversation-export-')
    )
    expect(writeExportFile).toHaveBeenNthCalledWith(
      1,
      join('/tmp/purescience-conversation-export-test', 'conversation.html'),
      expect.stringContaining('<!doctype html>')
    )
    expect(loadFile).toHaveBeenCalledWith(
      join('/tmp/purescience-conversation-export-test', 'conversation.html')
    )
    expect(executeJavaScript).toHaveBeenCalledOnce()
    expect(printToPDF).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 'A4', printBackground: true })
    )
    expect(writeExportFile).toHaveBeenNthCalledWith(2, '/downloads/export.pdf', Buffer.from('pdf'))
    expect(destroy).toHaveBeenCalledOnce()
    expect(removeDirectory).toHaveBeenCalledWith('/tmp/purescience-conversation-export-test')
    expect(result).toEqual({ saved: true, filePath: '/downloads/export.pdf' })
  })

  it('destroys the print window when PDF generation fails', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/export.pdf' })
    printToPDF.mockRejectedValue(new Error('print failed'))

    await expect(
      createService().exportConversation({
        projectId: 'project-1',
        sessionId: 'session-1',
        format: 'pdf'
      })
    ).rejects.toThrow('print failed')
    expect(destroy).toHaveBeenCalledOnce()
    expect(removeDirectory).toHaveBeenCalledWith('/tmp/purescience-conversation-export-test')
  })

  it('removes the temporary directory when writing the print document fails', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/export.pdf' })
    writeExportFile.mockRejectedValueOnce(new Error('temporary write failed'))

    await expect(
      createService().exportConversation({
        projectId: 'project-1',
        sessionId: 'session-1',
        format: 'pdf'
      })
    ).rejects.toThrow('temporary write failed')
    expect(createPrintWindow).not.toHaveBeenCalled()
    expect(removeDirectory).toHaveBeenCalledWith('/tmp/purescience-conversation-export-test')
  })

  it('does no rendering or writing when Save As is canceled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })

    await expect(
      createService().exportConversation({
        projectId: 'project-1',
        sessionId: 'session-1',
        format: 'pdf'
      })
    ).resolves.toEqual({ saved: false })
    expect(createPrintWindow).not.toHaveBeenCalled()
    expect(writeExportFile).not.toHaveBeenCalled()
  })

  it('rejects a live prompt after its durable status was normalized on load', async () => {
    loadSession.mockResolvedValue({ ...session, status: 'error' })
    isSessionActive.mockReturnValue(true)

    await expect(
      createService().exportConversation({
        projectId: 'project-1',
        sessionId: 'session-1',
        format: 'markdown'
      })
    ).rejects.toThrow('finish before exporting')

    expect(isSessionActive).toHaveBeenCalledWith('project-1', 'session-1')
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('rejects missing, empty, active and malformed conversations', async () => {
    loadSession.mockResolvedValueOnce(undefined)
    await expect(
      createService().exportConversation({
        projectId: 'project-1',
        sessionId: 'missing',
        format: 'markdown'
      })
    ).rejects.toThrow('Conversation not found.')

    loadSession.mockResolvedValueOnce({ ...session, messages: [] })
    await expect(
      createService().exportConversation({
        projectId: 'project-1',
        sessionId: 'session-1',
        format: 'markdown'
      })
    ).rejects.toThrow('no messages')

    loadSession.mockResolvedValueOnce({ ...session, status: 'running' })
    await expect(
      createService().exportConversation({
        projectId: 'project-1',
        sessionId: 'session-1',
        format: 'pdf'
      })
    ).rejects.toThrow('finish before exporting')

    loadSession.mockResolvedValueOnce({ ...session, status: 'waiting-permission' })
    await expect(
      createService().exportConversation({
        projectId: 'project-1',
        sessionId: 'session-1',
        format: 'markdown'
      })
    ).rejects.toThrow('finish before exporting')

    await expect(
      createService().exportConversation({
        projectId: '',
        sessionId: 'session-1',
        format: 'markdown'
      })
    ).rejects.toThrow('Invalid conversation export request.')
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('rejects malformed round selections before touching the session', async () => {
    const invalidRounds: unknown[] = [
      { from: 0, to: 2 },
      { from: 3, to: 2 },
      { from: 1.5, to: 2 },
      { from: 1, to: '2' },
      { from: 1 }
    ]

    for (const rounds of invalidRounds) {
      await expect(
        createService().exportConversation({
          projectId: 'project-1',
          sessionId: 'session-1',
          format: 'markdown',
          rounds: rounds as { from: number; to: number }
        })
      ).rejects.toThrow('Invalid conversation export round selection.')
    }
    expect(loadSession).not.toHaveBeenCalled()
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('accepts a valid round selection and exports only those turns', async () => {
    const multiTurnSession = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: 'message-user-2',
          role: 'user',
          content: 'Second prompt',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'message-agent-2',
          role: 'agent',
          content: 'Second answer.',
          status: 'complete',
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ]
    }
    loadSession.mockResolvedValueOnce(multiTurnSession)
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/out.md' })

    const result = await createService().exportConversation({
      projectId: 'project-1',
      sessionId: 'session-1',
      format: 'markdown',
      rounds: { from: 2, to: 2 }
    })

    expect(result.saved).toBe(true)
    expect(writeExportFile).toHaveBeenCalledWith(
      '/tmp/out.md',
      expect.stringContaining('Second prompt')
    )
    const written = String(writeExportFile.mock.calls[0][1])
    expect(written).not.toContain('# Question')
    expect(written).toContain('Second answer.')
  })
})

describe('conversation export IPC handler', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    fromWebContents.mockReset()
  })

  it('registers the export channel and forwards the request with its parent window', async () => {
    const request = {
      projectId: 'project-1',
      sessionId: 'session-1',
      format: 'pdf' as const
    }
    const sender = { id: 7 }
    const parentWindow = { id: 8 }
    const exportConversation = vi.fn().mockResolvedValue({ saved: false })
    fromWebContents.mockReturnValue(parentWindow)

    registerConversationExportIpcHandler({ exportConversation })

    expect([...ipcHandlers.keys()]).toEqual(['sessions:export-conversation'])
    await expect(
      ipcHandlers.get('sessions:export-conversation')?.({ sender }, request)
    ).resolves.toEqual({ saved: false })
    expect(fromWebContents).toHaveBeenCalledWith(sender)
    expect(exportConversation).toHaveBeenCalledWith(request, parentWindow)
  })
})
