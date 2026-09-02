// Native tray labels per supported UI language. The tray lives in the main process where the
// renderer dictionaries are not importable, so this small table keeps the handful of tray strings
// localized. Follows the persisted/system language at tray creation time.
export type TrayLabels = {
  show: string
  hide: string
  quit: string
  openWebUi: string
  copyUrl: string
  tooltip: string
  webTooltip: string
}

const TRAY_LABELS: Record<string, TrayLabels> = {
  en: {
    show: 'Show',
    hide: 'Hide',
    quit: 'Quit',
    openWebUi: 'Open Web UI',
    copyUrl: 'Copy URL',
    tooltip: 'PureScience',
    webTooltip: 'PureScience (Web)'
  },
  zh: {
    show: '显示',
    hide: '隐藏',
    quit: '退出',
    openWebUi: '打开网页界面',
    copyUrl: '复制链接',
    tooltip: 'PureScience',
    webTooltip: 'PureScience（网页）'
  },
  'zh-Hant': {
    show: '顯示',
    hide: '隱藏',
    quit: '退出',
    openWebUi: '開啟網頁介面',
    copyUrl: '複製連結',
    tooltip: 'PureScience',
    webTooltip: 'PureScience（網頁）'
  },
  ja: {
    show: '表示',
    hide: '非表示',
    quit: '終了',
    openWebUi: 'Web UI を開く',
    copyUrl: 'URL をコピー',
    tooltip: 'PureScience',
    webTooltip: 'PureScience（Web）'
  },
  ko: {
    show: '표시',
    hide: '숨기기',
    quit: '종료',
    openWebUi: '웹 UI 열기',
    copyUrl: 'URL 복사',
    tooltip: 'PureScience',
    webTooltip: 'PureScience（웹）'
  },
  fr: {
    show: 'Afficher',
    hide: 'Masquer',
    quit: 'Quitter',
    openWebUi: 'Ouvrir l’interface web',
    copyUrl: 'Copier l’URL',
    tooltip: 'PureScience',
    webTooltip: 'PureScience (Web)'
  },
  de: {
    show: 'Anzeigen',
    hide: 'Ausblenden',
    quit: 'Beenden',
    openWebUi: 'Web-Oberfläche öffnen',
    copyUrl: 'URL kopieren',
    tooltip: 'PureScience',
    webTooltip: 'PureScience (Web)'
  },
  es: {
    show: 'Mostrar',
    hide: 'Ocultar',
    quit: 'Salir',
    openWebUi: 'Abrir interfaz web',
    copyUrl: 'Copiar URL',
    tooltip: 'PureScience',
    webTooltip: 'PureScience (Web)'
  },
  ru: {
    show: 'Показать',
    hide: 'Скрыть',
    quit: 'Выйти',
    openWebUi: 'Открыть веб-интерфейс',
    copyUrl: 'Скопировать URL',
    tooltip: 'PureScience',
    webTooltip: 'PureScience (веб)'
  }
}

const normalizeTrayLocale = (locale: string): string => {
  const normalized = locale.toLowerCase()
  if (normalized.startsWith('zh')) {
    return normalized.includes('tw') || normalized.includes('hk') || normalized.includes('hant')
      ? 'zh-Hant'
      : 'zh'
  }
  if (normalized.startsWith('ja')) return 'ja'
  if (normalized.startsWith('ko')) return 'ko'
  if (normalized.startsWith('fr')) return 'fr'
  if (normalized.startsWith('de')) return 'de'
  if (normalized.startsWith('es')) return 'es'
  if (normalized.startsWith('ru')) return 'ru'
  return 'en'
}

// Resolves tray labels from an Electron/BCP-47 locale string (e.g. 'zh-CN', 'de-DE'); English when
// the locale is outside the supported set.
export const trayLabelsForLocale = (locale: string): TrayLabels =>
  TRAY_LABELS[normalizeTrayLocale(locale)] ?? TRAY_LABELS.en
