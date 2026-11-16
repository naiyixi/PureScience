import type { Notification } from 'electron'

import type { ComputeApprovalRequest } from '../../shared/compute'
import type {
  ConnectorApprovalRequest,
  ConversationSkillImportApprovalRequest
} from '../../shared/settings'
import type { ComputeApprovalContext } from '../compute/compute-approval-broker'
import type { Logger } from '../logger'
import type { NativeLocaleCode } from '../native-locale'
import { renderTaskNotification } from './task-notification-strings'
import {
  runTaskNotificationInBackground,
  type TaskNotificationRequest,
  type TaskNotificationService
} from './task-notifications'

// Builds the `show` callback the task-notification service hands notifications to. Extracted from
// registerIpcHandlers so the headless and Notification.isSupported gates have a unit-level home —
// inline closures were untestable, and a future regression on the headless contract would be invisible
// to the existing TaskNotificationService tests (which only see the primitive filter rules).
export type BuildTaskNotificationShowDeps = {
  notificationCtor: typeof Notification
  liveNotifications: Set<Notification>
  log: Pick<Logger, 'info'>
  headless: boolean
  // The language this banner is drawn in. A banner is drawn by the OS with no renderer behind it, so
  // the in-app language preference is unreachable here; the caller passes the OS locale resolved by
  // native-locale.ts. Required rather than defaulted: a delivery path that forgot it would quietly
  // ship English to the other eight languages, which is the defect this seam exists to close.
  resolveLocaleCode: () => NativeLocaleCode
}

export const buildTaskNotificationShow =
  (deps: BuildTaskNotificationShowDeps) =>
  (request: TaskNotificationRequest): void => {
    // Headless --serve launches never notify by contract: there is no local desktop user to see the
    // banner, and a click here would create a main window where none belongs.
    if (deps.headless) return
    // Daemon-less Linux hosts degrade the same way.
    if (!deps.notificationCtor.isSupported()) return

    // The banner text is re-rendered in the OS language from the structured descriptor. `request.title`
    // is the canonical English wording, kept for the log: the two together make "delivered in the
    // wrong language" and "the wording drifted" distinguishable after the fact.
    const language = deps.resolveLocaleCode()
    const { title, body } = renderTaskNotification(request.descriptor, language)

    const notification = new deps.notificationCtor({ title, body })

    // Logged so a silently-swallowed banner (OS permission, Focus mode) is distinguishable from a
    // gate that stopped delivery source.
    deps.log.info('delivering task notification', {
      title,
      canonicalTitle: request.title,
      language,
      supported: true
    })
    // Retain the instance until the banner resolves; a GC before click would silently drop the
    // handler on some platforms.
    deps.liveNotifications.add(notification)
    notification.once('click', () => {
      deps.liveNotifications.delete(notification)
      request.onClick()
    })
    notification.once('close', () => deps.liveNotifications.delete(notification))
    notification.show()
  }

// Builds the ApprovalBroker broadcast callback. The wire-up is the exact seam that the previous
// spec review flagged: a wrong implementation (e.g. forgetting to pass sessionId through, or routing
// to the wrong broadcast channel) would break notification click-to-open without TaskNotificationService
// tests catching it.
export type BuildConnectorApprovalBroadcastDeps = {
  broadcastToRenderers: (
    channel: 'connectors:approval-request',
    payload: ConnectorApprovalRequest
  ) => void
  taskNotifications: Pick<TaskNotificationService, 'handleConnectorApproval'>
  onNotificationError?: (error: unknown) => void
}

export const buildConnectorApprovalBroadcast =
  (deps: BuildConnectorApprovalBroadcastDeps) =>
  (request: ConnectorApprovalRequest): void => {
    deps.broadcastToRenderers('connectors:approval-request', request)
    runTaskNotificationInBackground(
      () => deps.taskNotifications.handleConnectorApproval(request, request.sessionId),
      deps.onNotificationError
    )
  }

export type BuildComputeApprovalBroadcastDeps = {
  broadcastToRenderers: (
    channel: 'compute:approval-request',
    payload: ComputeApprovalRequest
  ) => void
  taskNotifications: Pick<TaskNotificationService, 'handleComputeApproval'>
  onNotificationError?: (error: unknown) => void
}

// Compute's grant check owns the session context, so preserve it through the broker broadcast while
// keeping the renderer payload unchanged.
export const buildComputeApprovalBroadcast =
  (deps: BuildComputeApprovalBroadcastDeps) =>
  (request: ComputeApprovalRequest, context?: ComputeApprovalContext): void => {
    deps.broadcastToRenderers('compute:approval-request', request)
    runTaskNotificationInBackground(
      () => deps.taskNotifications.handleComputeApproval(request, context?.sessionId),
      deps.onNotificationError
    )
  }

export type BuildSkillImportApprovalBroadcastDeps = {
  broadcastToRenderers: (
    channel: 'skills:conversation-import-request',
    payload: ConversationSkillImportApprovalRequest
  ) => void
  taskNotifications: Pick<TaskNotificationService, 'handleSkillImportApproval'>
  onNotificationError?: (error: unknown) => void
}

// A Skill import already carries its session id, so one callback can deliver both the renderer card
// and the background desktop signal.
export const buildSkillImportApprovalBroadcast =
  (deps: BuildSkillImportApprovalBroadcastDeps) =>
  (request: ConversationSkillImportApprovalRequest): void => {
    deps.broadcastToRenderers('skills:conversation-import-request', request)
    runTaskNotificationInBackground(
      () => deps.taskNotifications.handleSkillImportApproval(request),
      deps.onNotificationError
    )
  }
