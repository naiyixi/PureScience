import { beforeEach, describe, expect, it, vi } from 'vitest'

const windows: Array<{
  destroyed: boolean
  isDestroyed: () => boolean
  webContents: { id?: number; send: ReturnType<typeof vi.fn> }
}> = []

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => windows
  }
}))

import { ApplicationEventHub } from './application-events'
import {
  addRendererBroadcastSink,
  broadcastToRenderers,
  installRendererBroadcastEventHub
} from './renderer-broadcast'

beforeEach(() => {
  windows.length = 0
})

describe('broadcastToRenderers', () => {
  it('sends to live Electron windows and registered external sinks', () => {
    const live = {
      destroyed: false,
      isDestroyed(): boolean {
        return this.destroyed
      },
      webContents: { send: vi.fn() }
    }
    const dead = {
      destroyed: true,
      isDestroyed(): boolean {
        return this.destroyed
      },
      webContents: { send: vi.fn() }
    }
    windows.push(live, dead)
    const sink = vi.fn()
    const remove = addRendererBroadcastSink(sink)

    broadcastToRenderers('remote-access:changed', {})
    expect(live.webContents.send).toHaveBeenCalledWith('remote-access:changed', {})
    expect(dead.webContents.send).not.toHaveBeenCalled()
    expect(sink).toHaveBeenCalledWith('remote-access:changed', {})

    remove()
    broadcastToRenderers('specialist:catalog-changed', undefined)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('projects one hub publication to Electron before external subscribers', () => {
    const live = {
      destroyed: false,
      isDestroyed(): boolean {
        return this.destroyed
      },
      webContents: { send: vi.fn() }
    }
    windows.push(live)
    const hub = new ApplicationEventHub()
    const order: string[] = []
    live.webContents.send.mockImplementation(() => order.push('electron'))
    const uninstall = installRendererBroadcastEventHub(hub)
    const remove = addRendererBroadcastSink(() => order.push('sink'))
    const payload = { sessionId: 'session-1', targetName: 'ANALYST' }

    hub.publish('specialist:pending-switch', payload)

    expect(order).toEqual(['electron', 'sink'])
    expect(live.webContents.send).toHaveBeenCalledWith('specialist:pending-switch', payload)
    remove()
    uninstall()
    hub.dispose()
  })

  it('keeps duplicate sink registration compatible with Set ownership', () => {
    const sink = vi.fn()
    const removeFirst = addRendererBroadcastSink(sink)
    const removeSecond = addRendererBroadcastSink(sink)

    broadcastToRenderers('specialist:catalog-changed', undefined)
    expect(sink).toHaveBeenCalledOnce()

    removeFirst()
    broadcastToRenderers('specialist:catalog-changed', undefined)
    expect(sink).toHaveBeenCalledOnce()
    removeSecond()
  })
})

describe('session:updated echoes', () => {
  const createWindow = (id: number): (typeof windows)[number] => ({
    destroyed: false,
    isDestroyed: () => false,
    webContents: { id, send: vi.fn() }
  })

  it('skips the window that made the change and still updates the others', () => {
    const origin = createWindow(7)
    const other = createWindow(9)
    windows.push(origin, other)

    broadcastToRenderers('session:updated', {
      session: {} as never,
      originClientId: 'electron:7'
    })

    expect(origin.webContents.send).not.toHaveBeenCalled()
    expect(other.webContents.send).toHaveBeenCalledOnce()
  })

  it('broadcasts a creation to the creating window as well', () => {
    const origin = createWindow(7)
    windows.push(origin)

    broadcastToRenderers('session:created', {
      session: {} as never,
      originClientId: 'electron:7'
    })

    expect(origin.webContents.send).toHaveBeenCalledOnce()
  })

  it('does not skip a window for identifiers that are not Electron clients', () => {
    const window = createWindow(7)
    windows.push(window)

    broadcastToRenderers('session:updated', {
      session: {} as never,
      originClientId: 'web:paired-client'
    })

    expect(window.webContents.send).toHaveBeenCalledOnce()
  })
})
