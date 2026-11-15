import type { NativeLocaleCode } from './native-locale'

// Copy for the native dialogs main draws itself — the ones with no renderer i18n provider behind
// them: the mid-migration quit confirm and the "window keeps dying" recovery prompt.
//
// Both dialogs appear at a moment when the reader has to make a decision under stress (the move is
// half-done; the window is blank), so English-only copy is not a cosmetic gap: a reader of one of the
// other eight languages is asked to choose between two buttons they cannot read. The tables are
// `Record<NativeLocaleCode, …>` so a missing language fails the compile rather than shipping English
// to that reader — the type is the closing gate, not a reviewer's eye.
//
// The English values are byte-identical to the literals these dialogs used to carry: the main-process
// tests assert them, and a native dialog has no other way to prove the wording did not drift.
//
// Product name stays untranslated in every language; only the sentence around it changes.
export type MigrationQuitStrings = {
  keepWaiting: string
  quitAnyway: string
  title: string
  message: string
  detail: string
}

export const MIGRATION_QUIT_STRINGS: Record<NativeLocaleCode, MigrationQuitStrings> = {
  en: {
    keepWaiting: 'Keep waiting',
    quitAnyway: 'Quit anyway',
    title: 'Move in progress',
    message: 'PureScience is still moving your data.',
    detail:
      'Your data is safe either way, but quitting now leaves the move unfinished — you may need to start it again. Keep the app open until it finishes.'
  },
  zh: {
    keepWaiting: '继续等待',
    quitAnyway: '仍然退出',
    title: '正在移动数据',
    message: 'PureScience 仍在移动你的数据。',
    detail:
      '两种选择下你的数据都是安全的，但现在退出会让这次移动半途而废——你可能需要重新开始。请保持应用开启，直到它完成。'
  },
  'zh-Hant': {
    keepWaiting: '繼續等待',
    quitAnyway: '仍然退出',
    title: '正在移動資料',
    message: 'PureScience 仍在移動你的資料。',
    detail:
      '兩種選擇下你的資料都是安全的，但現在退出會讓這次移動半途而廢——你可能需要重新開始。請保持應用程式開啟，直到它完成。'
  },
  ja: {
    keepWaiting: '待機を続ける',
    quitAnyway: 'それでも終了',
    title: 'データを移動しています',
    message: 'PureScience はデータを移動しています。',
    detail:
      'どちらを選んでもデータは安全ですが、今終了すると移動が途中で止まり、やり直しが必要になる場合があります。完了するまでアプリを開いたままにしてください。'
  },
  ko: {
    keepWaiting: '계속 기다리기',
    quitAnyway: '그래도 종료',
    title: '데이터 이동 중',
    message: 'PureScience가 데이터를 이동하고 있습니다.',
    detail:
      '어느 쪽을 선택해도 데이터는 안전하지만, 지금 종료하면 이동이 중간에 끊겨 다시 시작해야 할 수 있습니다. 완료될 때까지 앱을 열어 두세요.'
  },
  es: {
    keepWaiting: 'Seguir esperando',
    quitAnyway: 'Salir de todos modos',
    title: 'Movimiento en curso',
    message: 'PureScience todavía está moviendo tus datos.',
    detail:
      'Tus datos están a salvo en ambos casos, pero salir ahora deja la operación a medias y puede que tengas que iniciarla de nuevo. Mantén la aplicación abierta hasta que termine.'
  },
  de: {
    keepWaiting: 'Weiter warten',
    quitAnyway: 'Trotzdem beenden',
    title: 'Verschieben läuft',
    message: 'PureScience verschiebt noch deine Daten.',
    detail:
      'Deine Daten sind in beiden Fällen sicher, aber ein Beenden jetzt lässt den Vorgang unvollendet — du musst ihn möglicherweise neu starten. Lass die App bis zum Abschluss geöffnet.'
  },
  fr: {
    keepWaiting: 'Continuer d’attendre',
    quitAnyway: 'Quitter quand même',
    title: 'Déplacement en cours',
    message: 'PureScience déplace encore vos données.',
    detail:
      'Vos données sont en sécurité dans les deux cas, mais quitter maintenant laisse le déplacement inachevé — vous devrez peut-être le relancer. Gardez l’application ouverte jusqu’à la fin.'
  },
  ru: {
    keepWaiting: 'Продолжить ожидание',
    quitAnyway: 'Всё равно выйти',
    title: 'Идёт перемещение',
    message: 'PureScience всё ещё перемещает ваши данные.',
    detail:
      'Ваши данные в любом случае в безопасности, но если выйти сейчас, перемещение останется незавершённым — возможно, его придётся запустить заново. Не закрывайте приложение до завершения.'
  }
}

export type RendererRecoveryStrings = {
  reload: string
  closeWindow: string
  message: string
  detail: string
}

export const RENDERER_RECOVERY_STRINGS: Record<NativeLocaleCode, RendererRecoveryStrings> = {
  en: {
    reload: 'Reload',
    closeWindow: 'Close window',
    message: 'The app window stopped responding repeatedly.',
    detail:
      'Automatic recovery has been paused. Reloading returns this window to the home screen; background work may still be running.'
  },
  zh: {
    reload: '重新加载',
    closeWindow: '关闭窗口',
    message: 'PureScience 的窗口反复失去响应。',
    detail: '自动恢复已暂停。重新加载会把这个窗口带回首页；后台工作可能仍在运行。'
  },
  'zh-Hant': {
    reload: '重新載入',
    closeWindow: '關閉視窗',
    message: 'PureScience 的視窗反覆沒有回應。',
    detail: '自動復原已暫停。重新載入會把這個視窗帶回首頁；後台工作可能仍在執行。'
  },
  ja: {
    reload: '再読み込み',
    closeWindow: 'ウィンドウを閉じる',
    message: 'アプリのウィンドウが繰り返し応答しなくなりました。',
    detail:
      '自動復旧は停止しました。再読み込みするとこのウィンドウはホーム画面に戻ります。バックグラウンドの処理はまだ実行中の可能性があります。'
  },
  ko: {
    reload: '다시 불러오기',
    closeWindow: '창 닫기',
    message: '앱 창이 반복적으로 응답하지 않았습니다.',
    detail:
      '자동 복구가 중지되었습니다. 다시 불러오면 이 창은 홈 화면으로 돌아갑니다. 백그라운드 작업은 계속 실행 중일 수 있습니다.'
  },
  es: {
    reload: 'Recargar',
    closeWindow: 'Cerrar ventana',
    message: 'La ventana de la aplicación dejó de responder varias veces.',
    detail:
      'La recuperación automática se ha pausado. Recargar devuelve esta ventana a la pantalla de inicio; el trabajo en segundo plano puede seguir en marcha.'
  },
  de: {
    reload: 'Neu laden',
    closeWindow: 'Fenster schließen',
    message: 'Das App-Fenster hat wiederholt nicht reagiert.',
    detail:
      'Die automatische Wiederherstellung ist angehalten. Ein Neuladen bringt dieses Fenster zum Startbildschirm zurück; Hintergrundarbeit läuft möglicherweise weiter.'
  },
  fr: {
    reload: 'Recharger',
    closeWindow: 'Fermer la fenêtre',
    message: 'La fenêtre de l’application a cessé de répondre à plusieurs reprises.',
    detail:
      'La récupération automatique est en pause. Recharger ramène cette fenêtre à l’écran d’accueil ; un travail en arrière-plan peut encore être en cours.'
  },
  ru: {
    reload: 'Перезагрузить',
    closeWindow: 'Закрыть окно',
    message: 'Окно приложения несколько раз переставало отвечать.',
    detail:
      'Автоматическое восстановление приостановлено. Перезагрузка вернёт это окно на главный экран; фоновая работа может продолжаться.'
  }
}
