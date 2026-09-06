import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'

import type { ActiveSessionInfo } from '../shared/storage'
import {
  WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL,
  WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL,
  type CloseActionPreference,
  type CloseConfirmChoice,
  type CloseConfirmRequest,
  type CloseConfirmResponse,
  type CloseConfirmVariant
} from '../shared/window-controls'

export type NativeCloseConfirmResult = {
  choice: CloseConfirmChoice
  remember?: boolean
}

// Structural (Electron-free) plumbing so the coordinator is unit-testable; the Electron glue that
// satisfies this is createElectronCloseConfirm below.
export type CloseConfirmDeps = {
  // Send the request to the renderer (webContents.send).
  send: (payload: CloseConfirmRequest) => void
  // Subscribe to renderer responses for the lifetime of one confirm; returns an unsubscribe.
  onResponse: (cb: (payload: CloseConfirmResponse) => void) => () => void
  // Whether a live renderer exists to receive the request (window + webContents present, not gone).
  isRendererAvailable: () => boolean
  // Subscribe to render-process-gone for the confirm window; returns an unsubscribe.
  onRenderGone: (cb: () => void) => () => void
  // Subscribe to the confirm window's paired 'unresponsive'/'responsive' events; returns an
  // unsubscribe. Lets the coordinator fall back only on a SUSTAINED hang (renderer alive but wedged,
  // so render-process-gone never fires), never on a slow-but-alive renderer. Optional: absent in
  // tests that don't exercise the hang path.
  onRendererUnresponsive?: (cbs: { onHang: () => void; onRecover: () => void }) => () => void
  // Native fallback when the renderer can't answer (dead/hung, or no window at all). May reject;
  // the coordinator wraps it so a rejection never leaves the confirm unsettled.
  nativeFallback: (variant: CloseConfirmVariant) => Promise<NativeCloseConfirmResult>
  // Read/write the saved Windows titlebar-close behavior. Persistence failures fall back to asking.
  getClosePreference: () => Promise<CloseActionPreference | undefined>
  setClosePreference: (preference: CloseActionPreference) => Promise<void>
  newRequestId: () => string
  // Grace period for the modal-mounted ack before falling back. Defaults to 500ms.
  ackTimeoutMs?: number
  // Grace period after an ACKed modal goes 'unresponsive' before falling back. Defaults to 10s so a
  // brief hang the renderer recovers from doesn't yank the modal out from under the user.
  hangGraceMs?: number
}

export type ClosePreferenceAccess = {
  get: () => Promise<CloseActionPreference | undefined>
  set: (preference: CloseActionPreference) => Promise<void>
}

const DEFAULT_ACK_TIMEOUT_MS = 500
const DEFAULT_HANG_GRACE_MS = 10_000

// Coordinates a close/quit confirmation. Main computes `sessions`, so the quit variant with an empty
// list resolves without any IPC; otherwise the renderer renders the modal and replies the choice,
// with a native/proceed fallback if it can't.
export const createCloseConfirm = (
  deps: CloseConfirmDeps
): ((
  variant: CloseConfirmVariant,
  sessions: ActiveSessionInfo[]
) => Promise<CloseConfirmChoice>) => {
  const ackTimeoutMs = deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
  const hangGraceMs = deps.hangGraceMs ?? DEFAULT_HANG_GRACE_MS

  return async (variant, sessions) => {
    if (variant === 'quit' && sessions.length === 0) return 'quit'

    if (variant === 'close-to-tray') {
      const preference = await deps.getClosePreference().catch(() => undefined)
      if (preference) return preference
    }

    const persistPreference = async (
      choice: CloseConfirmChoice,
      remember = false
    ): Promise<void> => {
      if (variant === 'close-to-tray' && remember && (choice === 'minimize' || choice === 'quit')) {
        await deps.setClosePreference(choice).catch(() => undefined)
      }
    }

    // Never let a fallback rejection leave the confirm unsettled: a stranded promise would pin the
    // caller's in-flight guard forever and permanently block quit. On failure, keep the app resident
    // for close-to-tray and proceed for quit.
    const safeFallback = async (): Promise<CloseConfirmChoice> => {
      try {
        const result = await deps.nativeFallback(variant)
        await persistPreference(result.choice, result.remember)
        return result.choice
      } catch {
        return variant === 'quit' ? 'quit' : 'minimize'
      }
    }

    if (!deps.isRendererAvailable()) return safeFallback()

    const requestId = deps.newRequestId()

    return new Promise<CloseConfirmChoice>((resolve) => {
      let settled = false
      let acked = false
      let fallbackStarted = false
      let hangTimer: ReturnType<typeof setTimeout> | undefined

      const finish = (choice: CloseConfirmChoice, remember = false): void => {
        if (settled) return
        settled = true
        clearTimeout(ackTimer)
        clearTimeout(hangTimer)
        offResponse()
        offGone()
        offHang?.()
        void persistPreference(choice, remember).then(() => resolve(choice))
      }

      // Known limitation (cosmetic): when a fallback settles the confirm, a modal the renderer had
      // already shown (ack path) stays on screen. A late click on it is dropped — the response
      // listener is removed and `settled` guards it — so it merely closes locally with no effect.
      // Fully dismissing it would need a main->renderer dismiss message; not worth the protocol
      // surface for a rare hang/timeout case.
      const startFallback = (): void => {
        if (fallbackStarted) return
        fallbackStarted = true
        clearTimeout(ackTimer)
        clearTimeout(hangTimer)
        void safeFallback().then(finish)
      }

      const offResponse = deps.onResponse((payload) => {
        if (payload.requestId !== requestId) return
        if (payload.ack) {
          acked = true
          clearTimeout(ackTimer)
          return
        }
        if (payload.choice) finish(payload.choice, payload.remember)
      })

      const offGone = deps.onRenderGone(startFallback)

      // A sustained hang AFTER ack: the pre-ack window is already covered by ackTimer, and the modal
      // legitimately waits on the user, so only arm the grace timer once the renderer actually reports
      // 'unresponsive'; a paired 'responsive' cancels it. This chain is deliberately separate from
      // onRenderGone: a crash/reload never emits 'responsive' (recovery is same-process only), so a
      // reloaded renderer is covered by render-process-gone -> startFallback, not by this timer.
      const offHang = deps.onRendererUnresponsive?.({
        onHang: () => {
          if (!acked || settled) return
          hangTimer = setTimeout(startFallback, hangGraceMs)
        },
        onRecover: () => clearTimeout(hangTimer)
      })

      const ackTimer = setTimeout(() => {
        if (!acked) startFallback()
      }, ackTimeoutMs)

      deps.send({ requestId, variant, sessions })
    })
  }
}

// Native fallback when the renderer can't render the modal (dead/hung, or no window — e.g. macOS
// after the window was closed but the app stays resident). The coordinator only reaches this with
// work running (an empty quit list fast-paths to 'quit'), so both variants still ASK: quit offers
// Quit/Cancel, close-to-tray offers Minimize/Quit. A destroyed window can't parent a dialog, so fall
// back to a windowless one.
//
// The strings follow the renderer modal's locale. The renderer stores its preference in
// localStorage ('system' default), so main approximates it the same way menus/tray do: resolve
// Electron's OS locale against the same 9-language set; an explicit in-app override that diverges
// from the OS is a deliberately rare path and the renderer modal (which always wins when alive)
// still honors it exactly.
type NativeQuitStrings = {
  cancel: string
  quit: string
  minimize: string
  quitMessage: string
  quitDetail: string
  minimizeMessage: string
  minimizeDetail: string
  dontAskAgain: string
}

const NATIVE_QUIT_STRINGS: Record<string, NativeQuitStrings> = {
  en: {
    cancel: 'Cancel',
    quit: 'Quit',
    minimize: 'Minimize to tray',
    quitMessage: 'Quit PureScience?',
    quitDetail: 'Work is still running and will be interrupted if you quit.',
    minimizeMessage: 'Minimize to tray or quit?',
    minimizeDetail: 'Background work may still be running.',
    dontAskAgain: "Don't ask again"
  },
  zh: {
    cancel: '取消',
    quit: '退出',
    minimize: '最小化到托盘',
    quitMessage: '退出 PureScience？',
    quitDetail: '仍有工作正在运行，退出将中断它们。',
    minimizeMessage: '最小化还是退出？',
    minimizeDetail: '后台可能仍有工作正在运行。',
    dontAskAgain: '不再询问'
  },
  'zh-Hant': {
    cancel: '取消',
    quit: '退出',
    minimize: '最小化到系統匣',
    quitMessage: '退出 PureScience？',
    quitDetail: '仍有工作正在執行，退出將中斷它們。',
    minimizeMessage: '最小化還是退出？',
    minimizeDetail: '背景可能仍有工作正在執行。',
    dontAskAgain: '不再詢問'
  },
  ja: {
    cancel: 'キャンセル',
    quit: '終了',
    minimize: 'トレイに最小化',
    quitMessage: 'PureScience を終了しますか？',
    quitDetail: '作業がまだ実行中です。終了すると中断されます。',
    minimizeMessage: '最小化しますか、それとも終了しますか？',
    minimizeDetail: 'バックグラウンド作業が実行中の場合があります。',
    dontAskAgain: '今後表示しない'
  },
  ko: {
    cancel: '취소',
    quit: '종료',
    minimize: '트레이로 최소화',
    quitMessage: 'PureScience를 종료할까요?',
    quitDetail: '실행 중인 작업이 있습니다. 종료하면 중단됩니다.',
    minimizeMessage: '최소화할까요, 아니면 종료할까요?',
    minimizeDetail: '백그라운드 작업이 실행 중일 수 있습니다.',
    dontAskAgain: '다시 묻지 않기'
  },
  es: {
    cancel: 'Cancelar',
    quit: 'Salir',
    minimize: 'Minimizar a la bandeja',
    quitMessage: '¿Salir de PureScience?',
    quitDetail: 'Todavía hay trabajo en ejecución y se interrumpirá si sales.',
    minimizeMessage: '¿Minimizar o salir?',
    minimizeDetail: 'Puede haber trabajo en segundo plano en ejecución.',
    dontAskAgain: 'No volver a preguntar'
  },
  de: {
    cancel: 'Abbrechen',
    quit: 'Beenden',
    minimize: 'In den Tray minimieren',
    quitMessage: 'PureScience beenden?',
    quitDetail: 'Es läuft noch Arbeit; sie wird beim Beenden unterbrochen.',
    minimizeMessage: 'Minimieren oder beenden?',
    minimizeDetail: 'Im Hintergrund läuft möglicherweise noch Arbeit.',
    dontAskAgain: 'Nicht erneut fragen'
  },
  fr: {
    cancel: 'Annuler',
    quit: 'Quitter',
    minimize: 'Réduire dans la barre d’état',
    quitMessage: 'Quitter PureScience ?',
    quitDetail: 'Un travail est encore en cours et sera interrompu si vous quittez.',
    minimizeMessage: 'Réduire ou quitter ?',
    minimizeDetail: 'Un travail en arrière-plan est peut-être en cours.',
    dontAskAgain: 'Ne plus demander'
  },
  ru: {
    cancel: 'Отмена',
    quit: 'Выйти',
    minimize: 'Свернуть в трей',
    quitMessage: 'Выйти из PureScience?',
    quitDetail: 'Работа ещё выполняется и будет прервана при выходе.',
    minimizeMessage: 'Свернуть или выйти?',
    minimizeDetail: 'В фоне может выполняться работа.',
    dontAskAgain: 'Больше не спрашивать'
  }
}

const nativeStringsForLocale = (): NativeQuitStrings => {
  // app may be absent under unit tests that mock only dialog/BrowserWindow; the interop getter for a
  // missing named export throws on access, so fall back to English there.
  let locale = 'en'
  try {
    locale = app.getLocale().toLowerCase()
  } catch {
    // unit-test electron mock without an `app` export
  }
  const code = locale.startsWith('zh')
    ? locale.startsWith('zh-hant') || locale.startsWith('zh-tw') || locale.startsWith('zh-hk')
      ? 'zh-Hant'
      : 'zh'
    : locale.startsWith('ja')
      ? 'ja'
      : locale.startsWith('ko')
        ? 'ko'
        : locale.startsWith('es')
          ? 'es'
          : locale.startsWith('de')
            ? 'de'
            : locale.startsWith('fr')
              ? 'fr'
              : locale.startsWith('ru')
                ? 'ru'
                : 'en'
  return NATIVE_QUIT_STRINGS[code]
}

const nativeFallback = async (
  getWindow: () => BrowserWindow | undefined,
  variant: CloseConfirmVariant
): Promise<NativeCloseConfirmResult> => {
  const s = nativeStringsForLocale()
  const options =
    variant === 'quit'
      ? {
          type: 'question' as const,
          buttons: [s.cancel, s.quit],
          defaultId: 0,
          cancelId: 0,
          title: 'PureScience',
          message: s.quitMessage,
          detail: s.quitDetail
        }
      : {
          type: 'question' as const,
          buttons: [s.minimize, s.quit],
          defaultId: 0,
          cancelId: 0,
          title: 'PureScience',
          message: s.minimizeMessage,
          detail: s.minimizeDetail,
          checkboxLabel: s.dontAskAgain,
          checkboxChecked: true
        }
  const window = getWindow()
  const { response, checkboxChecked } =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
  if (variant === 'quit') return { choice: response === 1 ? 'quit' : 'cancel' }
  return {
    choice: response === 1 ? 'quit' : 'minimize',
    remember: checkboxChecked
  }
}

// Wires createCloseConfirm to Electron IPC + the current main window (via getWindow, since the window
// can be recreated). Response listeners are per-confirm and removed when it settles.
export const createElectronCloseConfirm = (
  getWindow: () => BrowserWindow | undefined,
  preferences: ClosePreferenceAccess
): ((variant: CloseConfirmVariant, sessions: ActiveSessionInfo[]) => Promise<CloseConfirmChoice>) =>
  createCloseConfirm({
    // Reveal the window before asking: a tray/Ctrl+Q quit can arrive while the window is hidden
    // (minimized to tray), and a modal sent to a hidden window would never be seen — leaving the
    // confirm (and thus the quit) stuck. Restoring/showing/focusing guarantees the modal is visible.
    send: (payload) => {
      const window = getWindow()
      if (!window || window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      if (!window.isVisible()) window.show()
      window.focus()
      window.webContents.send(WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL, payload)
    },
    onResponse: (cb) => {
      const listener = (_event: unknown, payload: CloseConfirmResponse): void => cb(payload)
      ipcMain.on(WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL, listener)
      return () => ipcMain.removeListener(WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL, listener)
    },
    isRendererAvailable: () => {
      const window = getWindow()
      return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
    },
    onRenderGone: (cb) => {
      const window = getWindow()
      if (!window) return () => undefined
      window.webContents.on('render-process-gone', cb)
      return () => window.webContents.off('render-process-gone', cb)
    },
    onRendererUnresponsive: ({ onHang, onRecover }) => {
      const window = getWindow()
      if (!window) return () => undefined
      window.webContents.on('unresponsive', onHang)
      window.webContents.on('responsive', onRecover)
      return () => {
        window.webContents.off('unresponsive', onHang)
        window.webContents.off('responsive', onRecover)
      }
    },
    nativeFallback: (variant) => nativeFallback(getWindow, variant),
    getClosePreference: preferences.get,
    setClosePreference: preferences.set,
    newRequestId: () => randomUUID()
  })
