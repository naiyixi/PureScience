import type { BackgroundDeliveryLabels } from './background-delivery'

// The continuation turn and the delivery ledger are read long after they are written — often in a
// session the reader reopens the next morning — so their wording follows the interface language
// rather than the language the app happened to start in. ids, paths and fingerprints are never
// translated: the point of those is that someone else can check them.
//
// Kept in shared code because both ends need the same words: the main process writes the continuation
// turn (which must be right even with no window open), and the renderer renders the ledger panel.
export const BACKGROUND_DELIVERY_LABELS_BY_LOCALE: Record<string, BackgroundDeliveryLabels> = {
  en: {
    header: 'Background result delivery',
    state: 'State',
    stateNames: {
      'waiting-result': 'waiting for the result',
      pending: 'ready to deliver',
      claimed: 'being delivered',
      dispatching: 'being delivered',
      consumed: 'delivered',
      'needs-attention': 'needs attention'
    },
    job: 'Job',
    files: 'Files',
    fingerprint: 'Fingerprint',
    reason: 'Reason',
    reasonNames: {
      'job-not-found': 'no such job',
      'session-mismatch': 'the job belongs to another session',
      'session-unavailable': 'the session could not be read',
      'not-consumable': 'there is nothing to deliver yet',
      'claim-held': 'another worker is delivering it',
      'result-unreadable': 'the result could not be read'
    },
    continuation: 'A background job has finished. Its recorded result is attached to this turn.',
    noResult: 'No result was produced'
  },
  zh: {
    header: '后台结果投递',
    state: '状态',
    stateNames: {
      'waiting-result': '等待结果',
      pending: '可投递',
      claimed: '投递中',
      dispatching: '投递中',
      consumed: '已投递',
      'needs-attention': '需人工处理'
    },
    job: '作业',
    files: '产物文件',
    fingerprint: '内容指纹',
    reason: '原因',
    reasonNames: {
      'job-not-found': '作业不存在',
      'session-mismatch': '该作业属于其他会话',
      'session-unavailable': '会话无法读取',
      'not-consumable': '暂无可投递内容',
      'claim-held': '另一进程正在投递',
      'result-unreadable': '结果无法读取'
    },
    continuation: '后台作业已完成，其记录的结果已附在本回合中。',
    noResult: '未产出结果'
  },
  'zh-Hant': {
    header: '後台結果投遞',
    state: '狀態',
    stateNames: {
      'waiting-result': '等待結果',
      pending: '可投遞',
      claimed: '投遞中',
      dispatching: '投遞中',
      consumed: '已投遞',
      'needs-attention': '需人工處理'
    },
    job: '作業',
    files: '產物檔案',
    fingerprint: '內容指紋',
    reason: '原因',
    reasonNames: {
      'job-not-found': '作業不存在',
      'session-mismatch': '該作業屬於其他工作階段',
      'session-unavailable': '工作階段無法讀取',
      'not-consumable': '暫無可投遞內容',
      'claim-held': '另一程序正在投遞',
      'result-unreadable': '結果無法讀取'
    },
    continuation: '後台作業已完成，其記錄的結果已附在本回合中。',
    noResult: '未產出結果'
  },
  ja: {
    header: 'バックグラウンド結果の配信',
    state: '状態',
    stateNames: {
      'waiting-result': '結果待ち',
      pending: '配信可能',
      claimed: '配信中',
      dispatching: '配信中',
      consumed: '配信済み',
      'needs-attention': '要確認'
    },
    job: 'ジョブ',
    files: '出力ファイル',
    fingerprint: '内容フィンガープリント',
    reason: '理由',
    reasonNames: {
      'job-not-found': '該当するジョブがありません',
      'session-mismatch': 'このジョブは別のセッションに属します',
      'session-unavailable': 'セッションを読み取れませんでした',
      'not-consumable': '配信できる結果がまだありません',
      'claim-held': '別のワーカーが配信中です',
      'result-unreadable': '結果を読み取れませんでした'
    },
    continuation:
      'バックグラウンドジョブが完了しました。記録された結果をこのターンに添付しました。',
    noResult: '結果は生成されませんでした'
  },
  ko: {
    header: '백그라운드 결과 전달',
    state: '상태',
    stateNames: {
      'waiting-result': '결과 대기 중',
      pending: '전달 준비됨',
      claimed: '전달 중',
      dispatching: '전달 중',
      consumed: '전달됨',
      'needs-attention': '확인 필요'
    },
    job: '작업',
    files: '출력 파일',
    fingerprint: '내용 지문',
    reason: '사유',
    reasonNames: {
      'job-not-found': '해당 작업이 없습니다',
      'session-mismatch': '다른 세션의 작업입니다',
      'session-unavailable': '세션을 읽을 수 없습니다',
      'not-consumable': '아직 전달할 결과가 없습니다',
      'claim-held': '다른 작업자가 전달 중입니다',
      'result-unreadable': '결과를 읽을 수 없습니다'
    },
    continuation: '백그라운드 작업이 완료되었습니다. 기록된 결과를 이 턴에 첨부했습니다.',
    noResult: '결과가 생성되지 않았습니다'
  },
  fr: {
    header: 'Livraison du résultat en arrière-plan',
    state: 'État',
    stateNames: {
      'waiting-result': 'en attente du résultat',
      pending: 'prêt à livrer',
      claimed: 'livraison en cours',
      dispatching: 'livraison en cours',
      consumed: 'livré',
      'needs-attention': 'à traiter'
    },
    job: 'Tâche',
    files: 'Fichiers',
    fingerprint: 'Empreinte',
    reason: 'Motif',
    reasonNames: {
      'job-not-found': 'cette tâche n’existe pas',
      'session-mismatch': 'la tâche appartient à une autre session',
      'session-unavailable': 'la session n’a pas pu être lue',
      'not-consumable': 'rien à livrer pour l’instant',
      'claim-held': 'un autre processus est en train de livrer',
      'result-unreadable': 'le résultat n’a pas pu être lu'
    },
    continuation:
      'Une tâche en arrière-plan est terminée. Son résultat enregistré est joint à ce tour.',
    noResult: 'Aucun résultat n’a été produit'
  },
  de: {
    header: 'Lieferung von Hintergrund-Ergebnissen',
    state: 'Status',
    stateNames: {
      'waiting-result': 'wartet auf das Ergebnis',
      pending: 'bereit zur Lieferung',
      claimed: 'wird geliefert',
      dispatching: 'wird geliefert',
      consumed: 'geliefert',
      'needs-attention': 'erfordert Prüfung'
    },
    job: 'Aufgabe',
    files: 'Dateien',
    fingerprint: 'Inhalts-Fingerabdruck',
    reason: 'Grund',
    reasonNames: {
      'job-not-found': 'diese Aufgabe gibt es nicht',
      'session-mismatch': 'die Aufgabe gehört zu einer anderen Sitzung',
      'session-unavailable': 'die Sitzung konnte nicht gelesen werden',
      'not-consumable': 'noch nichts zu liefern',
      'claim-held': 'ein anderer Prozess liefert gerade',
      'result-unreadable': 'das Ergebnis konnte nicht gelesen werden'
    },
    continuation:
      'Eine Hintergrundaufgabe ist abgeschlossen. Ihr aufgezeichnetes Ergebnis ist diesem Turn beigefügt.',
    noResult: 'Es wurde kein Ergebnis erzeugt'
  },
  es: {
    header: 'Entrega del resultado en segundo plano',
    state: 'Estado',
    stateNames: {
      'waiting-result': 'esperando el resultado',
      pending: 'listo para entregar',
      claimed: 'entrega en curso',
      dispatching: 'entrega en curso',
      consumed: 'entregado',
      'needs-attention': 'requiere atención'
    },
    job: 'Tarea',
    files: 'Archivos',
    fingerprint: 'Huella',
    reason: 'Motivo',
    reasonNames: {
      'job-not-found': 'esa tarea no existe',
      'session-mismatch': 'la tarea pertenece a otra sesión',
      'session-unavailable': 'no se pudo leer la sesión',
      'not-consumable': 'todavía no hay nada que entregar',
      'claim-held': 'otro proceso la está entregando',
      'result-unreadable': 'no se pudo leer el resultado'
    },
    continuation:
      'Una tarea en segundo plano ha terminado. Su resultado registrado se adjunta a este turno.',
    noResult: 'No se produjo ningún resultado'
  },
  ru: {
    header: 'Доставка результата фоновой задачи',
    state: 'Состояние',
    stateNames: {
      'waiting-result': 'ожидание результата',
      pending: 'готово к доставке',
      claimed: 'доставка выполняется',
      dispatching: 'доставка выполняется',
      consumed: 'доставлено',
      'needs-attention': 'требует внимания'
    },
    job: 'Задача',
    files: 'Файлы',
    fingerprint: 'Отпечаток содержимого',
    reason: 'Причина',
    reasonNames: {
      'job-not-found': 'такой задачи нет',
      'session-mismatch': 'задача относится к другой сессии',
      'session-unavailable': 'не удалось прочитать сессию',
      'not-consumable': 'пока нечего доставлять',
      'claim-held': 'доставкой занят другой процесс',
      'result-unreadable': 'не удалось прочитать результат'
    },
    continuation: 'Фоновая задача завершена. Её записанный результат приложен к этому ходу.',
    noResult: 'Результат не был создан'
  }
}

// 'system' has already been resolved by the renderer before it reports a language, but a stored value
// can still be a BCP-47 tag: match the whole tag first, then the language subtag, then English.
export const backgroundDeliveryLabelsFor = (
  locale: string | undefined | null
): BackgroundDeliveryLabels => {
  const fallback = BACKGROUND_DELIVERY_LABELS_BY_LOCALE.en
  const trimmed = locale?.trim()
  if (!trimmed) return fallback
  const normalized = trimmed.replace(/_/g, '-')
  const lower = normalized.toLowerCase()
  // Traditional Chinese ships as its own dictionary, so it must not fall through to `zh`.
  if (lower.startsWith('zh')) {
    return lower.includes('hant') ||
      lower.includes('-tw') ||
      lower.includes('-hk') ||
      lower.includes('-mo')
      ? BACKGROUND_DELIVERY_LABELS_BY_LOCALE['zh-Hant']
      : BACKGROUND_DELIVERY_LABELS_BY_LOCALE.zh
  }
  const exact = Object.keys(BACKGROUND_DELIVERY_LABELS_BY_LOCALE).find(
    (key) => key.toLowerCase() === lower
  )
  if (exact) return BACKGROUND_DELIVERY_LABELS_BY_LOCALE[exact]
  const primary = lower.split('-')[0]
  return BACKGROUND_DELIVERY_LABELS_BY_LOCALE[primary] ?? fallback
}
