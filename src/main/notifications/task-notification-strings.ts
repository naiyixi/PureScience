import type { NotificationKind } from '../../shared/notifications'
import type { NativeLocaleCode } from '../native-locale'

// Copy for the task-completion banners the OS draws itself.
//
// These banners are the one place where a finished task reaches a user who is not looking at the app,
// and main used to author them in English only: a reader of the other eight languages got
// `Task completed` / `The agent finished responding to "Plot the curve".` on their desktop. There is
// no renderer behind a banner, so the sentence cannot come from the in-app dictionaries — same reason
// the native dialogs carry their own table.
//
// Two properties make this table safe to grow:
//
//  * `Record<NativeLocaleCode, …>` plus a non-optional field list: a language that is missing, or a
//    sentence that was never written for a language, fails the compile instead of shipping English.
//  * The English column is byte-identical to the literals the notification service carried before the
//    table existed (the service's own tests pin them), so extracting the wording did not silently
//    reword the banners English readers already saw.
//
// The descriptor is the same closed taxonomy the message centre uses (`NotificationKind` in
// shared/notifications): a banner and the inbox card for the same event cannot end up in two
// vocabularies. The `satisfies` below is what makes that a compile-time fact rather than a
// comment — renaming or dropping a kind there fails this file instead of drifting silently.

export const BANNER_KINDS = [
  'task.completed',
  'task.needs-attention',
  'task.failed',
  'authorization.required'
] as const satisfies readonly NotificationKind[]

export type TaskNotificationDescriptor =
  // A turn ended on its own (`end_turn`).
  | { kind: 'task.completed'; task?: string }
  // A turn ended, but not cleanly: the model's length limit, the turn-request budget, a refusal, or
  // any stop reason this build does not know.
  | {
      kind: 'task.needs-attention'
      task?: string
      reason: 'max-tokens' | 'max-turns' | 'refusal' | 'unclean'
      // For 'unclean' only: the sanitised raw stop reason, already wrapped in parentheses. Carried
      // rather than re-derived so the banner and the English pin show the same text.
      detail?: string
    }
  // The prompt failed (only a genuine prompt failure reaches here; see describeTaskNotification).
  | { kind: 'task.failed'; task?: string; detail: string }
  // A blocking approval — a permission request, a connector egress approval, a compute job, or a
  // conversation skill import — is parked until the user answers.
  | { kind: 'authorization.required'; task?: string; detail: string }

export type TaskNotificationCopy = {
  // Stands in for the quoted task name when the prompt had no first line to quote.
  subject: string
  // Quote pair around a task name. English keeps ASCII quotes: that wording is pinned byte for byte.
  quotes: readonly [string, string]
  titles: {
    completed: string
    attention: string
    failed: string
    approval: string
  }
  completed: {
    withTask: string
    bare: string
  }
  attention: {
    // `{subject}` is the quoted task name or the generic subject, whichever applies.
    maxTokens: string
    maxTurns: string
    refusalWithTask: string
    refusalBare: string
    // `{reason}` is empty unless a raw stop reason was available.
    unclean: string
  }
  failed: {
    withTask: string
    bare: string
  }
  approval: {
    withTask: string
  }
}

// Some platforms clip a toast hard (Windows around 200 chars); the localized sentence gets the same
// ceiling the English one had.
export const TASK_NOTIFICATION_MAX_BODY_LENGTH = 200

export const TASK_NOTIFICATION_COPY: Record<NativeLocaleCode, TaskNotificationCopy> = {
  en: {
    subject: 'The agent',
    quotes: ['"', '"'],
    titles: {
      completed: 'Task completed',
      attention: 'Task needs attention',
      failed: 'Task failed',
      approval: 'Approval needed'
    },
    completed: {
      withTask: 'The agent finished responding to {task}.',
      bare: 'The agent finished responding.'
    },
    attention: {
      maxTokens: "{subject} stopped early — the answer hit the model's length limit.",
      maxTurns: '{subject} paused — send a message to keep it going.',
      refusalWithTask: '{task} was declined by the agent.',
      refusalBare: 'The agent declined the request.',
      unclean: '{subject} finished without a clean completion status{reason}.'
    },
    failed: {
      withTask: '{task} failed: {detail}',
      bare: '{detail}'
    },
    approval: {
      withTask: '{subject} needs your approval: {detail}'
    }
  },
  zh: {
    subject: '智能体',
    quotes: ['「', '」'],
    titles: {
      completed: '任务完成',
      attention: '任务需要处理',
      failed: '任务失败',
      approval: '需要批准'
    },
    completed: {
      withTask: '智能体已完成对{task}的回复。',
      bare: '智能体已完成回复。'
    },
    attention: {
      maxTokens: '{subject}提前结束——回答达到了模型的长度上限。',
      maxTurns: '{subject}已暂停——发一条消息就能继续。',
      refusalWithTask: '{task}被智能体拒绝了。',
      refusalBare: '智能体拒绝了这个请求。',
      unclean: '{subject}结束了，但没有干净收尾{reason}。'
    },
    failed: {
      withTask: '{task}失败：{detail}',
      bare: '{detail}'
    },
    approval: {
      withTask: '{subject}需要你的批准：{detail}'
    }
  },
  'zh-Hant': {
    subject: '智慧體',
    quotes: ['「', '」'],
    titles: {
      completed: '任務完成',
      attention: '任務需要處理',
      failed: '任務失敗',
      approval: '需要核准'
    },
    completed: {
      withTask: '智慧體已完成對{task}的回覆。',
      bare: '智慧體已完成回覆。'
    },
    attention: {
      maxTokens: '{subject}提前結束——回答達到了模型的長度上限。',
      maxTurns: '{subject}已暫停——傳一則訊息就能繼續。',
      refusalWithTask: '{task}被智慧體拒絕了。',
      refusalBare: '智慧體拒絕了這個請求。',
      unclean: '{subject}結束了，但沒有乾淨收尾{reason}。'
    },
    failed: {
      withTask: '{task}失敗：{detail}',
      bare: '{detail}'
    },
    approval: {
      withTask: '{subject}需要你的核准：{detail}'
    }
  },
  ja: {
    subject: 'エージェント',
    quotes: ['「', '」'],
    titles: {
      completed: 'タスクが完了しました',
      attention: 'タスクの確認が必要です',
      failed: 'タスクに失敗しました',
      approval: '承認が必要です'
    },
    completed: {
      withTask: 'エージェントが{task}への応答を終えました。',
      bare: 'エージェントが応答を終えました。'
    },
    attention: {
      maxTokens: '{subject}は途中で停止しました — 回答がモデルの長さ上限に達しました。',
      maxTurns: '{subject}は一時停止しました — メッセージを送ると続行します。',
      refusalWithTask: '{task}はエージェントに拒否されました。',
      refusalBare: 'エージェントがこのリクエストを拒否しました。',
      unclean: '{subject}は正常に完了しないまま終了しました{reason}。'
    },
    failed: {
      withTask: '{task}に失敗しました: {detail}',
      bare: '{detail}'
    },
    approval: {
      withTask: '{subject}があなたの承認を待っています: {detail}'
    }
  },
  ko: {
    subject: '에이전트',
    quotes: ['‘', '’'],
    titles: {
      completed: '작업 완료',
      attention: '작업 확인 필요',
      failed: '작업 실패',
      approval: '승인 필요'
    },
    completed: {
      withTask: '에이전트가 {task}에 대한 응답을 마쳤습니다.',
      bare: '에이전트가 응답을 마쳤습니다.'
    },
    attention: {
      maxTokens: '{subject}가 일찍 중단되었습니다 — 답변이 모델의 길이 한도에 도달했습니다.',
      maxTurns: '{subject}가 일시 중지되었습니다 — 메시지를 보내면 계속됩니다.',
      refusalWithTask: '{task}은(는) 에이전트가 거절했습니다.',
      refusalBare: '에이전트가 요청을 거절했습니다.',
      unclean: '{subject}가 정상적으로 끝나지 않은 채 종료되었습니다{reason}.'
    },
    failed: {
      withTask: '{task} 실패: {detail}',
      bare: '{detail}'
    },
    approval: {
      withTask: '{subject}의 승인이 필요합니다: {detail}'
    }
  },
  es: {
    subject: 'El agente',
    quotes: ['«', '»'],
    titles: {
      completed: 'Tarea completada',
      attention: 'La tarea requiere atención',
      failed: 'Tarea fallida',
      approval: 'Se necesita aprobación'
    },
    completed: {
      withTask: 'El agente terminó de responder a {task}.',
      bare: 'El agente terminó de responder.'
    },
    attention: {
      maxTokens:
        '{subject} se detuvo antes de tiempo: la respuesta alcanzó el límite de longitud del modelo.',
      maxTurns: '{subject} se pausó: envía un mensaje para continuar.',
      refusalWithTask: '{task} fue rechazada por el agente.',
      refusalBare: 'El agente rechazó la solicitud.',
      unclean: '{subject} terminó sin un cierre limpio{reason}.'
    },
    failed: {
      withTask: '{task} falló: {detail}',
      bare: '{detail}'
    },
    approval: {
      withTask: '{subject} necesita tu aprobación: {detail}'
    }
  },
  de: {
    subject: 'Der Agent',
    quotes: ['„', '“'],
    titles: {
      completed: 'Aufgabe abgeschlossen',
      attention: 'Aufgabe erfordert Aufmerksamkeit',
      failed: 'Aufgabe fehlgeschlagen',
      approval: 'Freigabe erforderlich'
    },
    completed: {
      withTask: 'Der Agent hat die Antwort auf {task} beendet.',
      bare: 'Der Agent hat die Antwort beendet.'
    },
    attention: {
      maxTokens:
        '{subject} wurde vorzeitig beendet – die Antwort hat das Längenlimit des Modells erreicht.',
      maxTurns: '{subject} wurde angehalten – sende eine Nachricht, um fortzufahren.',
      refusalWithTask: '{task} wurde vom Agenten abgelehnt.',
      refusalBare: 'Der Agent hat die Anfrage abgelehnt.',
      unclean: '{subject} endete ohne sauberen Abschluss{reason}.'
    },
    failed: {
      withTask: '{task} ist fehlgeschlagen: {detail}',
      bare: '{detail}'
    },
    approval: {
      withTask: '{subject} benötigt deine Freigabe: {detail}'
    }
  },
  fr: {
    subject: "L'agent",
    quotes: ['« ', ' »'],
    titles: {
      completed: 'Tâche terminée',
      attention: 'La tâche demande votre attention',
      failed: 'Échec de la tâche',
      approval: 'Approbation requise'
    },
    completed: {
      withTask: "L'agent a fini de répondre à {task}.",
      bare: "L'agent a fini de répondre."
    },
    attention: {
      maxTokens:
        "{subject} s'est arrêté prématurément : la réponse a atteint la limite de longueur du modèle.",
      maxTurns: '{subject} est en pause : envoyez un message pour continuer.',
      refusalWithTask: '{task} a été refusé par l’agent.',
      refusalBare: "L'agent a refusé la demande.",
      unclean: "{subject} s'est terminé sans clôture propre{reason}."
    },
    failed: {
      withTask: 'Échec de {task} : {detail}',
      bare: '{detail}'
    },
    approval: {
      withTask: '{subject} a besoin de votre approbation : {detail}'
    }
  },
  ru: {
    subject: 'Агент',
    quotes: ['«', '»'],
    titles: {
      completed: 'Задача выполнена',
      attention: 'Задача требует внимания',
      failed: 'Задача не выполнена',
      approval: 'Требуется подтверждение'
    },
    completed: {
      withTask: 'Агент завершил ответ на {task}.',
      bare: 'Агент завершил ответ.'
    },
    attention: {
      maxTokens: '{subject} остановился досрочно — ответ достиг предельной длины модели.',
      maxTurns: '{subject} приостановлен — отправьте сообщение, чтобы продолжить.',
      refusalWithTask: '{task} отклонён агентом.',
      refusalBare: 'Агент отклонил запрос.',
      unclean: '{subject} завершился без корректного статуса завершения{reason}.'
    },
    failed: {
      withTask: '{task}: ошибка — {detail}',
      bare: '{detail}'
    },
    approval: {
      withTask: '{subject} ожидает вашего подтверждения: {detail}'
    }
  }
}

// A placeholder with no value stays visible (`{detail}`) rather than collapsing to an empty sentence:
// a banner that reads like a completed thought while it is missing the reason is worse than one that
// obviously lost a value.
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)

const truncate = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text

// Early returns beat a switch that the compiler already knows is exhaustive: a trailing `return` for
// the last kind would be unreachable code, which this project's lint treats as a defect.
const bodyFor = (
  copy: TaskNotificationCopy,
  descriptor: TaskNotificationDescriptor,
  quoted: string | undefined,
  subject: string
): string => {
  if (descriptor.kind === 'task.completed') {
    return quoted ? fill(copy.completed.withTask, { task: quoted }) : copy.completed.bare
  }
  if (descriptor.kind === 'task.failed') {
    return quoted
      ? fill(copy.failed.withTask, { task: quoted, detail: descriptor.detail })
      : fill(copy.failed.bare, { detail: descriptor.detail })
  }
  if (descriptor.kind === 'authorization.required') {
    return fill(copy.approval.withTask, { subject, detail: descriptor.detail })
  }

  const values = { subject, task: quoted ?? '', reason: descriptor.detail ?? '' }

  if (descriptor.reason === 'max-tokens') return fill(copy.attention.maxTokens, values)
  if (descriptor.reason === 'max-turns') return fill(copy.attention.maxTurns, values)
  if (descriptor.reason === 'refusal') {
    return quoted ? fill(copy.attention.refusalWithTask, values) : copy.attention.refusalBare
  }

  return fill(copy.attention.unclean, values)
}

// Renders one notification for one language. Pure and free of Electron so every language can be
// asserted without a desktop: the caller resolves the locale (native-locale.ts) and hands it in.
export const renderTaskNotification = (
  descriptor: TaskNotificationDescriptor,
  code: NativeLocaleCode
): { title: string; body: string } => {
  const copy = TASK_NOTIFICATION_COPY[code]
  const quoted = descriptor.task
    ? `${copy.quotes[0]}${descriptor.task}${copy.quotes[1]}`
    : undefined
  const subject = quoted ?? copy.subject

  const titles: Record<(typeof BANNER_KINDS)[number], string> = {
    'task.completed': copy.titles.completed,
    'task.needs-attention': copy.titles.attention,
    'task.failed': copy.titles.failed,
    'authorization.required': copy.titles.approval
  }

  return {
    title: titles[descriptor.kind],
    body: truncate(bodyFor(copy, descriptor, quoted, subject), TASK_NOTIFICATION_MAX_BODY_LENGTH)
  }
}
