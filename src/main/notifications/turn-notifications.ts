// 会话任务完成时的 macOS 系统通知 (轻量, 无 Prisma/DB 依赖)
// 科学家跑长任务 (对接/模拟/批量检索) 时, 完成即弹系统通知提醒。
import { Notification } from 'electron'

export type TurnOutcomeKind = 'completed' | 'failed'

const OUTCOME_TEXT: Record<TurnOutcomeKind, string> = {
  completed: '任务已完成',
  failed: '任务执行失败'
}

let enabled: boolean | undefined

// 惰性初始化: 首次调用时检测通知支持 (app ready 后可用)
const ensureEnabled = (): void => {
  if (enabled !== undefined) return
  try {
    enabled = Notification.isSupported()
  } catch {
    enabled = false
  }
}

// 发一条任务完成/失败的系统通知 (fire-and-forget, 不阻塞 turn 流程)
export const notifyTurnOutcome = (kind: TurnOutcomeKind, sessionLabel?: string): void => {
  ensureEnabled()
  if (!enabled) return
  try {
    const title =
      sessionLabel && sessionLabel.trim() ? `PureScience · ${sessionLabel}` : 'PureScience'
    const n = new Notification({
      title,
      body: OUTCOME_TEXT[kind],
      silent: false
    })
    n.show()
  } catch {
    // 通知失败不影响任务本身
  }
}
