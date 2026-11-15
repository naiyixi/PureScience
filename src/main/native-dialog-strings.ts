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

// Copy for the OS file panels main opens itself. A save/open panel is drawn by the platform, so the
// renderer's i18n provider never reaches it: the title sitting above the file list, the file-type
// filter in the dropdown and the buttons on the overwrite confirm are all literal English today.
//
// The same rule as above applies — `Record<NativeLocaleCode, …>` makes a missing language a compile
// error — with one addition: the overwrite sentence is a function of the count, because plural forms
// are not shared (Russian needs three, Japanese and Korean need one). Keeping it a plain string with
// an "s" appended would ship "1 notebooks" to five readers and count nouns wrongly in two more.
//
// The filter name for a technical format stays out of these tables: `PDF` is `PDF` everywhere, and
// `Text` is the only descriptive one.
export type FileDialogStrings = {
  importConnectorTitle: string
  exportConnectorTitle: string
  connectorFilter: string
  importSessionPackageTitle: string
  exportSessionPackageTitle: string
  sessionPackageFilter: string
  exportSupportBundleTitle: string
  supportBundleFilter: string
  saveUpdateInstallerTitle: string
  saveFileTitle: string
  saveArtifactTitle: string
  chooseArtifactFolderTitle: string
  saveAnnotationNotesTitle: string
  saveAnnotatedCopyTitle: string
  annotationTextFilter: string
  exportNotebooksTitle: string
  overwriteNotebooksTitle: string
  overwriteNotebooksMessage: (count: number) => string
  overwriteButton: string
  cancelButton: string
}

export const FILE_DIALOG_STRINGS: Record<NativeLocaleCode, FileDialogStrings> = {
  en: {
    importConnectorTitle: 'Import Connector configuration',
    exportConnectorTitle: 'Export Connector configuration',
    connectorFilter: 'Connector configuration',
    importSessionPackageTitle: 'Import session package',
    exportSessionPackageTitle: 'Export session package',
    sessionPackageFilter: 'PureScience session package',
    exportSupportBundleTitle: 'Export support bundle',
    supportBundleFilter: 'Support bundle',
    saveUpdateInstallerTitle: 'Save the update installer',
    saveFileTitle: 'Save file',
    saveArtifactTitle: 'Save artifact',
    chooseArtifactFolderTitle: 'Choose where to save artifacts',
    saveAnnotationNotesTitle: 'Save annotation notes',
    saveAnnotatedCopyTitle: 'Save annotated copy',
    annotationTextFilter: 'Text',
    exportNotebooksTitle: 'Export notebooks by kernel',
    overwriteNotebooksTitle: 'Overwrite existing notebooks?',
    overwriteNotebooksMessage: (count: number): string =>
      // The singular branch used to read "1 notebook already exist" — the plural was appended but the
      // verb was not. The count is now a parameter, so the branch can say it correctly.
      count === 1
        ? '1 notebook already exists in the chosen directory.'
        : `${count} notebooks already exist in the chosen directory.`,
    overwriteButton: 'Overwrite',
    cancelButton: 'Cancel'
  },
  zh: {
    importConnectorTitle: '导入连接器配置',
    exportConnectorTitle: '导出连接器配置',
    connectorFilter: '连接器配置',
    importSessionPackageTitle: '导入会话包',
    exportSessionPackageTitle: '导出会话包',
    sessionPackageFilter: 'PureScience 会话包',
    exportSupportBundleTitle: '导出支持包',
    supportBundleFilter: '支持包',
    saveUpdateInstallerTitle: '保存更新安装包',
    saveFileTitle: '保存文件',
    saveArtifactTitle: '保存产物',
    chooseArtifactFolderTitle: '选择产物的保存位置',
    saveAnnotationNotesTitle: '保存批注笔记',
    saveAnnotatedCopyTitle: '保存带批注的副本',
    annotationTextFilter: '文本',
    exportNotebooksTitle: '按内核导出笔记本',
    overwriteNotebooksTitle: '覆盖已有笔记本？',
    overwriteNotebooksMessage: (count: number): string => `所选目录里已有 ${count} 个笔记本。`,
    overwriteButton: '覆盖',
    cancelButton: '取消'
  },
  'zh-Hant': {
    importConnectorTitle: '匯入連接器組態',
    exportConnectorTitle: '匯出連接器組態',
    connectorFilter: '連接器組態',
    importSessionPackageTitle: '匯入工作階段套件',
    exportSessionPackageTitle: '匯出工作階段套件',
    sessionPackageFilter: 'PureScience 工作階段套件',
    exportSupportBundleTitle: '匯出支援包',
    supportBundleFilter: '支援包',
    saveUpdateInstallerTitle: '儲存更新安裝程式',
    saveFileTitle: '儲存檔案',
    saveArtifactTitle: '儲存產物',
    chooseArtifactFolderTitle: '選擇產物的儲存位置',
    saveAnnotationNotesTitle: '儲存註解筆記',
    saveAnnotatedCopyTitle: '儲存含註解的副本',
    annotationTextFilter: '文字',
    exportNotebooksTitle: '依核心匯出筆記本',
    overwriteNotebooksTitle: '覆寫現有筆記本？',
    overwriteNotebooksMessage: (count: number): string => `所選目錄裡已有 ${count} 個筆記本。`,
    overwriteButton: '覆寫',
    cancelButton: '取消'
  },
  ja: {
    importConnectorTitle: 'コネクタ設定をインポート',
    exportConnectorTitle: 'コネクタ設定をエクスポート',
    connectorFilter: 'コネクタ設定',
    importSessionPackageTitle: 'セッションパッケージをインポート',
    exportSessionPackageTitle: 'セッションパッケージを書き出す',
    sessionPackageFilter: 'PureScience セッションパッケージ',
    exportSupportBundleTitle: 'サポートバンドルを書き出す',
    supportBundleFilter: 'サポートバンドル',
    saveUpdateInstallerTitle: 'アップデートのインストーラを保存',
    saveFileTitle: 'ファイルを保存',
    saveArtifactTitle: '成果物を保存',
    chooseArtifactFolderTitle: '成果物の保存先を選択',
    saveAnnotationNotesTitle: '注釈ノートを保存',
    saveAnnotatedCopyTitle: '注釈付きのコピーを保存',
    annotationTextFilter: 'テキスト',
    exportNotebooksTitle: 'カーネル別にノートブックを書き出す',
    overwriteNotebooksTitle: '既存のノートブックを上書きしますか？',
    overwriteNotebooksMessage: (count: number): string =>
      `選択したフォルダーには既に ${count} 件のノートブックがあります。`,
    overwriteButton: '上書き',
    cancelButton: 'キャンセル'
  },
  ko: {
    importConnectorTitle: '커넥터 구성 가져오기',
    exportConnectorTitle: '커넥터 구성 내보내기',
    connectorFilter: '커넥터 구성',
    importSessionPackageTitle: '세션 패키지 가져오기',
    exportSessionPackageTitle: '세션 패키지 내보내기',
    sessionPackageFilter: 'PureScience 세션 패키지',
    exportSupportBundleTitle: '지원 번들 내보내기',
    supportBundleFilter: '지원 번들',
    saveUpdateInstallerTitle: '업데이트 설치 관리자 저장',
    saveFileTitle: '파일 저장',
    saveArtifactTitle: '산출물 저장',
    chooseArtifactFolderTitle: '산출물 저장 위치 선택',
    saveAnnotationNotesTitle: '주석 노트 저장',
    saveAnnotatedCopyTitle: '주석이 포함된 사본 저장',
    annotationTextFilter: '텍스트',
    exportNotebooksTitle: '커널별로 노트북 내보내기',
    overwriteNotebooksTitle: '기존 노트북을 덮어쓸까요?',
    overwriteNotebooksMessage: (count: number): string =>
      `선택한 폴더에 이미 노트북 ${count}개가 있습니다.`,
    overwriteButton: '덮어쓰기',
    cancelButton: '취소'
  },
  es: {
    importConnectorTitle: 'Importar configuración del conector',
    exportConnectorTitle: 'Exportar configuración del conector',
    connectorFilter: 'Configuración del conector',
    importSessionPackageTitle: 'Importar paquete de sesión',
    exportSessionPackageTitle: 'Exportar paquete de sesión',
    sessionPackageFilter: 'Paquete de sesión de PureScience',
    exportSupportBundleTitle: 'Exportar paquete de soporte',
    supportBundleFilter: 'Paquete de soporte',
    saveUpdateInstallerTitle: 'Guardar el instalador de la actualización',
    saveFileTitle: 'Guardar archivo',
    saveArtifactTitle: 'Guardar artefacto',
    chooseArtifactFolderTitle: 'Elegir dónde guardar los artefactos',
    saveAnnotationNotesTitle: 'Guardar notas de anotación',
    saveAnnotatedCopyTitle: 'Guardar copia anotada',
    annotationTextFilter: 'Texto',
    exportNotebooksTitle: 'Exportar cuadernos por kernel',
    overwriteNotebooksTitle: '¿Sobrescribir los cuadernos existentes?',
    overwriteNotebooksMessage: (count: number): string =>
      count === 1
        ? '1 cuaderno ya existe en el directorio elegido.'
        : `${count} cuadernos ya existen en el directorio elegido.`,
    overwriteButton: 'Sobrescribir',
    cancelButton: 'Cancelar'
  },
  de: {
    importConnectorTitle: 'Konnektor-Konfiguration importieren',
    exportConnectorTitle: 'Konnektor-Konfiguration exportieren',
    connectorFilter: 'Konnektor-Konfiguration',
    importSessionPackageTitle: 'Sitzungspaket importieren',
    exportSessionPackageTitle: 'Sitzungspaket exportieren',
    sessionPackageFilter: 'PureScience-Sitzungspaket',
    exportSupportBundleTitle: 'Support-Paket exportieren',
    supportBundleFilter: 'Support-Paket',
    saveUpdateInstallerTitle: 'Update-Installer speichern',
    saveFileTitle: 'Datei speichern',
    saveArtifactTitle: 'Artefakt speichern',
    chooseArtifactFolderTitle: 'Speicherort für Artefakte wählen',
    saveAnnotationNotesTitle: 'Anmerkungsnotizen speichern',
    saveAnnotatedCopyTitle: 'Annotierte Kopie speichern',
    annotationTextFilter: 'Textdatei',
    exportNotebooksTitle: 'Notebooks nach Kernel exportieren',
    overwriteNotebooksTitle: 'Vorhandene Notebooks überschreiben?',
    overwriteNotebooksMessage: (count: number): string =>
      count === 1
        ? 'Im gewählten Ordner ist bereits 1 Notebook vorhanden.'
        : `Im gewählten Ordner sind bereits ${count} Notebooks vorhanden.`,
    overwriteButton: 'Überschreiben',
    cancelButton: 'Abbrechen'
  },
  fr: {
    importConnectorTitle: 'Importer la configuration du connecteur',
    exportConnectorTitle: 'Exporter la configuration du connecteur',
    connectorFilter: 'Configuration du connecteur',
    importSessionPackageTitle: 'Importer le paquet de session',
    exportSessionPackageTitle: 'Exporter le paquet de session',
    sessionPackageFilter: 'Paquet de session PureScience',
    exportSupportBundleTitle: 'Exporter l’archive de support',
    supportBundleFilter: 'Archive de support',
    saveUpdateInstallerTitle: 'Enregistrer l’installateur de mise à jour',
    saveFileTitle: 'Enregistrer le fichier',
    saveArtifactTitle: 'Enregistrer l’artefact',
    chooseArtifactFolderTitle: 'Choisir où enregistrer les artefacts',
    saveAnnotationNotesTitle: 'Enregistrer les notes d’annotation',
    saveAnnotatedCopyTitle: 'Enregistrer la copie annotée',
    annotationTextFilter: 'Texte',
    exportNotebooksTitle: 'Exporter les notebooks par noyau',
    overwriteNotebooksTitle: 'Écraser les notebooks existants ?',
    overwriteNotebooksMessage: (count: number): string =>
      count === 1
        ? '1 notebook existe déjà dans le dossier choisi.'
        : `${count} notebooks existent déjà dans le dossier choisi.`,
    overwriteButton: 'Écraser',
    cancelButton: 'Annuler'
  },
  ru: {
    importConnectorTitle: 'Импорт конфигурации коннектора',
    exportConnectorTitle: 'Экспорт конфигурации коннектора',
    connectorFilter: 'Конфигурация коннектора',
    importSessionPackageTitle: 'Импорт пакета сеанса',
    exportSessionPackageTitle: 'Экспортировать пакет сеанса',
    sessionPackageFilter: 'Пакет сеанса PureScience',
    exportSupportBundleTitle: 'Экспорт пакета поддержки',
    supportBundleFilter: 'Пакет поддержки',
    saveUpdateInstallerTitle: 'Сохранить установщик обновления',
    saveFileTitle: 'Сохранить файл',
    saveArtifactTitle: 'Сохранить артефакт',
    chooseArtifactFolderTitle: 'Выберите папку для артефактов',
    saveAnnotationNotesTitle: 'Сохранить заметки к аннотациям',
    saveAnnotatedCopyTitle: 'Сохранить копию с пометками',
    annotationTextFilter: 'Текст',
    exportNotebooksTitle: 'Экспорт ноутбуков по ядрам',
    overwriteNotebooksTitle: 'Перезаписать существующие ноутбуки?',
    overwriteNotebooksMessage: (count: number): string => {
      // Russian needs three forms here; the last digit decides, except that the teens (11–14) all
      // take the plural-of-five form.
      const last = count % 10
      const teens = count % 100 >= 11 && count % 100 <= 14
      const form = teens
        ? 'ноутбуков'
        : last === 1
          ? 'ноутбук'
          : last >= 2 && last <= 4
            ? 'ноутбука'
            : 'ноутбуков'
      return `${count} ${form} уже есть в выбранной папке.`
    },
    overwriteButton: 'Перезаписать',
    cancelButton: 'Отмена'
  }
}
