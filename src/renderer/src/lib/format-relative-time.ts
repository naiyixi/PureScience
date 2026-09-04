// Formats a past timestamp as a compact relative label (e.g. "5m", "17h", "3d") for dense lists.
// Unit suffixes follow the active UI language so a Chinese user sees "2周" instead of "2w" — the
// i18n provider pushes the concrete language via `setRelativeTimeLanguage`. Standalone consumers
// (tests, non-React callers) default to the compact English abbreviations.

export type RelativeTimeTable = {
  now: string
  m: string
  h: string
  d: string
  w: string
  mo: string
  y: string
}

const UNIT_TABLES: Record<string, RelativeTimeTable> = {
  en: { now: 'now', m: '{n}m', h: '{n}h', d: '{n}d', w: '{n}w', mo: '{n}mo', y: '{n}y' },
  zh: {
    now: '刚刚',
    m: '{n}分钟',
    h: '{n}小时',
    d: '{n}天',
    w: '{n}周',
    mo: '{n}个月',
    y: '{n}年'
  },
  'zh-Hant': {
    now: '剛剛',
    m: '{n}分鐘',
    h: '{n}小時',
    d: '{n}天',
    w: '{n}週',
    mo: '{n}個月',
    y: '{n}年'
  },
  ja: {
    now: 'たった今',
    m: '{n}分',
    h: '{n}時間',
    d: '{n}日',
    w: '{n}週間',
    mo: '{n}か月',
    y: '{n}年'
  },
  ko: {
    now: '방금',
    m: '{n}분',
    h: '{n}시간',
    d: '{n}일',
    w: '{n}주',
    mo: '{n}개월',
    y: '{n}년'
  },
  fr: {
    now: 'à l’instant',
    m: '{n} min',
    h: '{n} h',
    d: '{n} j',
    w: '{n} sem.',
    mo: '{n} mois',
    y: '{n} an'
  },
  de: {
    now: 'gerade',
    m: '{n} Min.',
    h: '{n} Std.',
    d: '{n} T.',
    w: '{n} Wo.',
    mo: '{n} Mo.',
    y: '{n} J.'
  },
  es: {
    now: 'ahora',
    m: '{n} min',
    h: '{n} h',
    d: '{n} d',
    w: '{n} sem.',
    mo: '{n} meses',
    y: '{n} a'
  },
  ru: {
    now: 'только что',
    m: '{n} мин',
    h: '{n} ч',
    d: '{n} дн',
    w: '{n} нед',
    mo: '{n} мес',
    y: '{n} г'
  }
}

let activeLanguage = 'en'

// The i18n provider calls this whenever the concrete UI language changes so dense relative labels
// match the surrounding copy. Unknown codes fall back to English abbreviations.
export const setRelativeTimeLanguage = (language: string): void => {
  activeLanguage = language in UNIT_TABLES ? language : 'en'
}

const render = (table: RelativeTimeTable, key: keyof RelativeTimeTable, value: number): string =>
  table[key].replace('{n}', String(value))

export const formatRelativeTime = (timestamp: number, now: number = Date.now()): string => {
  const table = UNIT_TABLES[activeLanguage] ?? UNIT_TABLES.en
  const elapsedMs = Math.max(0, now - timestamp)
  const seconds = Math.floor(elapsedMs / 1000)

  if (seconds < 45) return table.now

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return render(table, 'm', Math.max(1, minutes))

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return render(table, 'h', hours)

  const days = Math.floor(hours / 24)
  if (days < 7) return render(table, 'd', days)

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return render(table, 'w', weeks)

  const months = Math.floor(days / 30)
  // Switch to years only at a real year. Using `months < 12` here would leave 360–364 days (months === 12
  // by the /30 approximation, but still < 365) falling through to `days / 365` === 0, rendering "0y".
  if (days < 365) return render(table, 'mo', months)

  return render(table, 'y', Math.floor(days / 365))
}
