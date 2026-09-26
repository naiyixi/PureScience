import { BrowserWindow } from 'electron'

import type {
  ApplicationEventChannel,
  ApplicationEventMap,
  ApplicationEvents
} from './application-events'

export type RendererBroadcastSink = <Channel extends ApplicationEventChannel>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
) => void

let installedEvents: ApplicationEvents | undefined
let removeElectronProjection: (() => void) | undefined
const sinks = new Set<RendererBroadcastSink>()
const sinkSubscriptions = new Map<RendererBroadcastSink, () => void>()

// A committed Session write already returns its durable document to the caller, and the renderer that made
// the change applies that return value before this broadcast runs — so echoing `session:updated` back to the
// window that caused it is a whole-transcript round trip (measured: 55KB at turn 10, 242KB at turn 44) that
// the origin window discards. Other windows, remote and web clients still get it: they have no other way to
// learn about the change. Creation is deliberately not skipped — a new session's authoritative fields are
// only guaranteed to reach the renderer through the broadcast.
const originWebContentsId = <Channel extends ApplicationEventChannel>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
): number | undefined => {
  if (channel !== 'session:updated') return undefined
  const { originClientId } = payload as { originClientId?: unknown }
  if (typeof originClientId !== 'string') return undefined
  // Electron callers are identified by their webContents id (see `caller-context.ts`); web and remote
  // clients carry other identifiers and simply never match a window here.
  const matched = /^electron:(\d+)$/.exec(originClientId)
  return matched ? Number(matched[1]) : undefined
}

const projectToElectron = <Channel extends ApplicationEventChannel>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
): void => {
  const originId = originWebContentsId(channel, payload)
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    if (originId !== undefined && window.webContents.id === originId) continue
    window.webContents.send(channel, payload)
  }
}

// Compatibility facade for existing publishers. Production installs the application-owned hub
// before exposing IPC surfaces, so one publication fans out through ordered projections. The direct
// path keeps isolated unit tests and startup-before-install behavior identical to the old broadcaster.
const broadcastToRenderers = <Channel extends ApplicationEventChannel>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
): void => {
  if (installedEvents) {
    installedEvents.publish(channel, payload)
    return
  }

  projectToElectron(channel, payload)
  for (const sink of sinks) sink(channel, payload)
}

const subscribeSink = (events: ApplicationEvents, sink: RendererBroadcastSink): (() => void) =>
  events.subscribe((event) => sink(event.channel, event.payload))

const addRendererBroadcastSink = (sink: RendererBroadcastSink): (() => void) => {
  if (!sinks.has(sink)) {
    sinks.add(sink)
    if (installedEvents) sinkSubscriptions.set(sink, subscribeSink(installedEvents, sink))
  }

  return () => {
    if (!sinks.delete(sink)) return
    sinkSubscriptions.get(sink)?.()
    sinkSubscriptions.delete(sink)
  }
}

// The composition root owns the hub; this adapter only binds the legacy publisher facade and the
// Electron projection for one application runtime generation.
const installRendererBroadcastEventHub = (events: ApplicationEvents): (() => void) => {
  if (installedEvents) throw new Error('Renderer broadcast event hub is already installed.')
  installedEvents = events
  removeElectronProjection = events.subscribe((event) =>
    projectToElectron(event.channel, event.payload)
  )
  for (const sink of sinks) sinkSubscriptions.set(sink, subscribeSink(events, sink))

  return () => {
    if (installedEvents !== events) return
    removeElectronProjection?.()
    removeElectronProjection = undefined
    for (const unsubscribe of sinkSubscriptions.values()) unsubscribe()
    sinkSubscriptions.clear()
    installedEvents = undefined
  }
}

export { addRendererBroadcastSink, broadcastToRenderers, installRendererBroadcastEventHub }
