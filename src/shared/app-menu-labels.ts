export type AppMenuLabels = {
  about: string
  services: string
  hide: string
  hideOthers: string
  showAll: string
  quit: string
  file: string
  close: string
  edit: string
  undo: string
  redo: string
  cut: string
  copy: string
  paste: string
  selectAll: string
  view: string
  reload: string
  forceReload: string
  toggleDevTools: string
  actualSize: string
  zoomIn: string
  zoomOut: string
  toggleFullScreen: string
  windowMenu: string
  minimize: string
  zoom: string
  front: string
  help: string
}

export const APP_MENU_LABELS: Record<string, AppMenuLabels> = {
  en: {
    about: 'About PureScience',
    services: 'Services',
    hide: 'Hide PureScience',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: 'Quit PureScience',
    file: 'File',
    close: 'Close Window',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    reload: 'Reload',
    forceReload: 'Force Reload',
    toggleDevTools: 'Toggle Developer Tools',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullScreen: 'Toggle Full Screen',
    windowMenu: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
    help: 'Help'
  },
  zh: {
    about: '关于 PureScience',
    services: '服务',
    hide: '隐藏 PureScience',
    hideOthers: '隐藏其他',
    showAll: '全部显示',
    quit: '退出 PureScience',
    file: '文件',
    close: '关闭窗口',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    selectAll: '全选',
    view: '显示',
    reload: '重新加载',
    forceReload: '强制重新加载',
    toggleDevTools: '切换开发者工具',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullScreen: '切换全屏',
    windowMenu: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    front: '前置全部窗口',
    help: '帮助'
  },
  'zh-Hant': {
    about: '關於 PureScience',
    services: '服務',
    hide: '隱藏 PureScience',
    hideOthers: '隱藏其他',
    showAll: '全部顯示',
    quit: '結束 PureScience',
    file: '檔案',
    close: '關閉視窗',
    edit: '編輯',
    undo: '復原',
    redo: '重做',
    cut: '剪切',
    copy: '複製',
    paste: '貼上',
    selectAll: '全選',
    view: '顯示',
    reload: '重新載入',
    forceReload: '強制重新載入',
    toggleDevTools: '切換開發者工具',
    actualSize: '實際大小',
    zoomIn: '放大',
    zoomOut: '縮小',
    toggleFullScreen: '切換全螢幕',
    windowMenu: '視窗',
    minimize: '最小化',
    zoom: '縮放',
    front: '全部移到最前',
    help: '輔助說明'
  },
  ja: {
    about: 'PureScienceについて',
    services: 'サービス',
    hide: 'PureScienceを隠す',
    hideOthers: 'その他を隠す',
    showAll: 'すべてを表示',
    quit: 'PureScienceを終了',
    file: 'ファイル',
    close: 'ウインドウを閉じる',
    edit: '編集',
    undo: '取り消す',
    redo: 'やり直す',
    cut: '切り取り',
    copy: 'コピー',
    paste: 'ペースト',
    selectAll: 'すべてを選択',
    view: '表示',
    reload: 'リロード',
    forceReload: '強制リロード',
    toggleDevTools: '開発者ツールの切り替え',
    actualSize: '実際のサイズ',
    zoomIn: '拡大',
    zoomOut: '縮小',
    toggleFullScreen: 'フルスクリーン表示に切り替える',
    windowMenu: 'ウインドウ',
    minimize: '最小化',
    zoom: 'ズーム',
    front: 'すべてのウインドウを手前に移動',
    help: 'ヘルプ'
  },
  ko: {
    about: 'PureScience 정보',
    services: '서비스',
    hide: 'PureScience 숨기기',
    hideOthers: '기타 숨기기',
    showAll: '모두 보기',
    quit: 'PureScience 종료',
    file: '파일',
    close: '윈도우 닫기',
    edit: '편집',
    undo: '실행 취소',
    redo: '다시 실행',
    cut: '오려두기',
    copy: '복사',
    paste: '붙여넣기',
    selectAll: '모두 선택',
    view: '보기',
    reload: '새로고침',
    forceReload: '강제 새로고침',
    toggleDevTools: '개발자 도구 전환',
    actualSize: '실제 크기',
    zoomIn: '확대',
    zoomOut: '축소',
    toggleFullScreen: '전체 화면으로 전환',
    windowMenu: '윈도우',
    minimize: '최소화',
    zoom: '줌',
    front: '모두 앞으로 가져오기',
    help: '도움말'
  },
  fr: {
    about: 'À propos de PureScience',
    services: 'Services',
    hide: 'Masquer PureScience',
    hideOthers: 'Masquer les autres',
    showAll: 'Tout afficher',
    quit: 'Quitter PureScience',
    file: 'Fichier',
    close: 'Fermer la fenêtre',
    edit: 'Édition',
    undo: 'Annuler',
    redo: 'Rétablir',
    cut: 'Couper',
    copy: 'Copier',
    paste: 'Coller',
    selectAll: 'Tout sélectionner',
    view: 'Présentation',
    reload: 'Recharger',
    forceReload: 'Forcer le rechargement',
    toggleDevTools: 'Basculer les outils de développement',
    actualSize: 'Taille réelle',
    zoomIn: 'Agrandir',
    zoomOut: 'Réduire',
    toggleFullScreen: 'Basculer en plein écran',
    windowMenu: 'Fenêtre',
    minimize: 'Réduire',
    zoom: 'Zoom',
    front: 'Tout mettre au premier plan',
    help: 'Aide'
  },
  de: {
    about: 'Über PureScience',
    services: 'Dienste',
    hide: 'PureScience ausblenden',
    hideOthers: 'Andere ausblenden',
    showAll: 'Alle einblenden',
    quit: 'PureScience beenden',
    file: 'Ablage',
    close: 'Fenster schließen',
    edit: 'Bearbeiten',
    undo: 'Widerrufen',
    redo: 'Wiederholen',
    cut: 'Ausschneiden',
    copy: 'Kopieren',
    paste: 'Einsetzen',
    selectAll: 'Alles auswählen',
    view: 'Darstellung',
    reload: 'Neu laden',
    forceReload: 'Neu laden erzwingen',
    toggleDevTools: 'Entwicklertools umschalten',
    actualSize: 'Originalgröße',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    toggleFullScreen: 'Vollbild umschalten',
    windowMenu: 'Fenster',
    minimize: 'Minimieren',
    zoom: 'Zoomen',
    front: 'Alle Fenster nach vorne bringen',
    help: 'Hilfe'
  },
  es: {
    about: 'Acerca de PureScience',
    services: 'Servicios',
    hide: 'Ocultar PureScience',
    hideOthers: 'Ocultar otros',
    showAll: 'Mostrar todo',
    quit: 'Salir de PureScience',
    file: 'Archivo',
    close: 'Cerrar ventana',
    edit: 'Edición',
    undo: 'Deshacer',
    redo: 'Rehacer',
    cut: 'Cortar',
    copy: 'Copiar',
    paste: 'Pegar',
    selectAll: 'Seleccionar todo',
    view: 'Visualización',
    reload: 'Recargar',
    forceReload: 'Forzar recarga',
    toggleDevTools: 'Alternar herramientas de desarrollo',
    actualSize: 'Tamaño real',
    zoomIn: 'Acercar',
    zoomOut: 'Alejar',
    toggleFullScreen: 'Alternar pantalla completa',
    windowMenu: 'Ventana',
    minimize: 'Minimizar',
    zoom: 'Zoom',
    front: 'Traer todo al frente',
    help: 'Ayuda'
  },
  ru: {
    about: 'О программе PureScience',
    services: 'Службы',
    hide: 'Скрыть PureScience',
    hideOthers: 'Скрыть остальные',
    showAll: 'Показать все',
    quit: 'Завершить работу PureScience',
    file: 'Файл',
    close: 'Закрыть окно',
    edit: 'Правка',
    undo: 'Отменить',
    redo: 'Повторить',
    cut: 'Вырезать',
    copy: 'Копировать',
    paste: 'Вставить',
    selectAll: 'Выбрать все',
    view: 'Вид',
    reload: 'Перезагрузить',
    forceReload: 'Принудительная перезагрузка',
    toggleDevTools: 'Переключить инструменты разработчика',
    actualSize: 'Реальный размер',
    zoomIn: 'Увеличить',
    zoomOut: 'Уменьшить',
    toggleFullScreen: 'Переключить полноэкранный режим',
    windowMenu: 'Окно',
    minimize: 'Свернуть',
    zoom: 'Масштаб',
    front: 'Вывести все на передний план',
    help: 'Справка'
  }
}

export const appMenuLabelsForLocale = (locale: string): AppMenuLabels => {
  const l = String(locale ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (!l) return APP_MENU_LABELS.en
  if (l.startsWith('zh')) {
    return /^zh-(tw|hk|mo|hant)(-|$)/.test(l) ? APP_MENU_LABELS['zh-Hant'] : APP_MENU_LABELS.zh
  }
  const prefix = (['ja', 'ko', 'fr', 'de', 'es', 'ru'] as const).find(
    (p) => l === p || l.startsWith(p + '-')
  )
  return prefix ? APP_MENU_LABELS[prefix] : APP_MENU_LABELS.en
}
