import {
  isHiddenControlMessage,
  isHumanUserMessage,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../../../shared/session-persistence'
import type { PersistedAgentFrame } from '../../../../shared/conversation-graph'
import type { Project } from '../../../../shared/projects'

export type TokenUsagePeriod = 'today' | 'week' | '30-days' | 'all'

export type TokenUsageHeatmapMetric =
  | 'totalTokens'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheTokens'
  | 'newConversations'
  | 'newProjects'
  | 'newArtifacts'
  | 'runs'

// One attributed run: a root agent frame with the tokens it consumed directly plus the tokens of
// every descendant frame (sub-agent delegations, reviewers) so a run's real cost is visible.
export type TokenUsageRun = {
  frameId: string
  kind: 'root' | 'reviewer' | 'delegate' | 'compatibility'
  parentFrameId?: string
  startedAt: number
  agentName?: string
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  totalTokens: number
  subRunCount: number
  subRunTokens: number
}

export type TokenUsageDailyPoint = {
  dateKey: string
  dayStart: number
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  totalTokens: number
  newConversations: number
  newProjects: number
  newArtifacts: number
  runs: number
}

type TokenUsageEvent = {
  timestamp: number
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  rootRunUsage: boolean
}

export type TokenUsageAnalytics = {
  now: number
  last30Days: readonly TokenUsageDailyPoint[]
  sessionCreatedAt: readonly number[]
  projectCreatedAt: readonly number[]
  artifactCreatedAt: readonly number[]
  runsAt: readonly number[]
  usageEvents: readonly TokenUsageEvent[]
  runs: readonly TokenUsageRun[]
  totalArtifacts: number
}

export type TokenUsageSummary = {
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  totalTokens: number
  cacheShare: number | null
  totalSessions: number
  newConversations: number
  totalProjects: number
  newProjects: number
  totalArtifacts: number
  newArtifacts: number
  totalRuns: number
  newRuns: number
  reportedRuns: number
}

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 0

const startOfLocalDay = (timestamp: number): number => {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const addLocalDays = (timestamp: number, days: number): number => {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

const localDateKey = (timestamp: number): string => {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const periodStart = (now: number, period: TokenUsagePeriod): number => {
  const today = startOfLocalDay(now)
  if (period === 'today') return today
  if (period === '30-days') return addLocalDays(today, -29)
  if (period === 'all') return Number.NEGATIVE_INFINITY

  const weekday = new Date(today).getDay()
  return addLocalDays(today, -(weekday === 0 ? 6 : weekday - 1))
}

const isInPeriod = (timestamp: number, start: number, now: number): boolean =>
  Number.isFinite(timestamp) && timestamp >= start && timestamp <= now

const usageTimestamp = (message: PersistedChatMessage): number =>
  message.completedAt ?? message.updatedAt ?? message.createdAt

const createEmptyDailyPoint = (dayStart: number): TokenUsageDailyPoint => ({
  dateKey: localDateKey(dayStart),
  dayStart,
  inputTokens: 0,
  cacheTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  newConversations: 0,
  newProjects: 0,
  newArtifacts: 0,
  runs: 0
})

export const buildTokenUsageAnalytics = (
  sessions: readonly PersistedChatSession[],
  now: number = Date.now(),
  projects: readonly Project[] = []
): TokenUsageAnalytics => {
  const sessionCreatedAt: number[] = []
  const projectCreatedAt = projects.map((project) => project.createdAt)
  const runsAt: number[] = []
  const usageEvents: TokenUsageEvent[] = []
  const artifactIds = new Set<string>()
  const persistedArtifactCreatedAt = new Map<string, number>()
  const associatedArtifactCreatedAt = new Map<string, number>()

  for (const session of sessions) {
    sessionCreatedAt.push(session.createdAt)
    for (const artifact of session.artifacts ?? []) {
      artifactIds.add(artifact.id)
      const createdAt = artifact.mtimeMs
      if (createdAt !== undefined && Number.isFinite(createdAt) && createdAt >= 0) {
        persistedArtifactCreatedAt.set(artifact.id, createdAt)
      }
    }

    const graph = session.conversationGraph
    const messages: ReadonlyArray<{
      message: PersistedChatMessage
      isRootMessage: boolean
    }> = graph
      ? graph.messages.map((message) => ({
          message,
          isRootMessage: message.agentFrameId === graph.rootFrameId
        }))
      : session.messages.map((message) => ({ message, isRootMessage: true }))

    for (const { message, isRootMessage } of messages) {
      const associationTimestamp = message.completedAt ?? message.createdAt
      for (const artifactId of message.artifactIds ?? []) {
        const existingTimestamp = associatedArtifactCreatedAt.get(artifactId)
        if (
          Number.isFinite(associationTimestamp) &&
          associationTimestamp >= 0 &&
          (existingTimestamp === undefined || associationTimestamp < existingTimestamp)
        ) {
          associatedArtifactCreatedAt.set(artifactId, associationTimestamp)
        }
      }

      if (
        isRootMessage &&
        isHumanUserMessage(message) &&
        !isHiddenControlMessage(message)
      ) {
        runsAt.push(message.createdAt || session.createdAt)
      }

      if (message.role !== 'agent' || !message.turnUsage) continue

      const inputTokens = finiteNonNegative(message.turnUsage.inputTokens)
      const cacheTokens = finiteNonNegative(message.turnUsage.cacheTokens)
      const outputTokens = finiteNonNegative(message.turnUsage.outputTokens)
      usageEvents.push({
        timestamp: usageTimestamp(message),
        inputTokens,
        cacheTokens,
        outputTokens,
        rootRunUsage: isRootMessage
      })
    }
  }


  // Per-run attribution: group agent-message usage by agent frame. A root frame's run rolls up the
  // tokens of every descendant frame (delegates/reviewers) so each run shows its true cost.
  const frameById = new Map<string, PersistedAgentFrame>()
  for (const session of sessions) {
    for (const frame of session.conversationGraph?.frames ?? []) frameById.set(frame.id, frame)
  }
  const ownUsageByFrame = new Map<string, { input: number; cache: number; output: number }>()
  for (const session of sessions) {
    for (const message of session.conversationGraph?.messages ?? []) {
      if (message.role !== 'agent' || !message.turnUsage || !message.agentFrameId) continue
      const current = ownUsageByFrame.get(message.agentFrameId) ?? { input: 0, cache: 0, output: 0 }
      current.input += finiteNonNegative(message.turnUsage.inputTokens)
      current.cache += finiteNonNegative(message.turnUsage.cacheTokens)
      current.output += finiteNonNegative(message.turnUsage.outputTokens)
      ownUsageByFrame.set(message.agentFrameId, current)
    }
  }
  const runs: TokenUsageRun[] = []
  const parentOf = new Map<string, string | undefined>()
  for (const frame of frameById.values()) {
    const parentId = frame.kind === 'root' ? undefined : frame.parentFrameId
    parentOf.set(frame.id, parentId)
  }
  const subtreeTokens = (frameId: string, count: { n: number }): { input: number; cache: number; output: number } => {
    let input = 0
    let cache = 0
    let output = 0
    for (const [id, parentId] of parentOf) {
      if (parentId !== frameId) continue
      const own = ownUsageByFrame.get(id) ?? { input: 0, cache: 0, output: 0 }
      count.n += 1
      input += own.input
      cache += own.cache
      output += own.output
      const deeper = subtreeTokens(id, count)
      input += deeper.input
      cache += deeper.cache
      output += deeper.output
    }
    return { input, cache, output }
  }
  for (const frame of frameById.values()) {
    const own = ownUsageByFrame.get(frame.id) ?? { input: 0, cache: 0, output: 0 }
    const sub = { n: 0 }
    const rolled = subtreeTokens(frame.id, sub)
    runs.push({
      frameId: frame.id,
      kind: frame.kind,
      ...(frame.parentFrameId ? { parentFrameId: frame.parentFrameId } : {}),
      startedAt: frame.createdAt,
      ...(frame.agentName ? { agentName: frame.agentName } : {}),
      inputTokens: own.input,
      cacheTokens: own.cache,
      outputTokens: own.output,
      totalTokens: own.input + own.cache + own.output,
      subRunCount: sub.n,
      subRunTokens: rolled.input + rolled.cache + rolled.output
    })
  }
  // Sessions without a conversation graph: synthesize one root run from their agent-message usage.
  for (const session of sessions) {
    if (session.conversationGraph) continue
    let input = 0
    let cache = 0
    let output = 0
    for (const message of session.messages) {
      if (message.role !== 'agent' || !message.turnUsage) continue
      input += finiteNonNegative(message.turnUsage.inputTokens)
      cache += finiteNonNegative(message.turnUsage.cacheTokens)
      output += finiteNonNegative(message.turnUsage.outputTokens)
    }
    runs.push({
      frameId: session.id,
      kind: 'root',
      startedAt: session.createdAt,
      inputTokens: input,
      cacheTokens: cache,
      outputTokens: output,
      totalTokens: input + cache + output,
      subRunCount: 0,
      subRunTokens: 0
    })
  }
  runs.sort((a, b) => a.startedAt - b.startedAt)

  const artifactCreatedAt = Array.from(artifactIds).flatMap((artifactId) => {
    const timestamp =
      persistedArtifactCreatedAt.get(artifactId) ?? associatedArtifactCreatedAt.get(artifactId)
    return timestamp === undefined ? [] : [timestamp]
  })

  const today = startOfLocalDay(now)
  const last30Days = Array.from({ length: 30 }, (_, index) =>
    createEmptyDailyPoint(addLocalDays(today, index - 29))
  )
  const dailyByKey = new Map(last30Days.map((point) => [point.dateKey, point]))

  for (const timestamp of sessionCreatedAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.newConversations += 1
  }

  for (const timestamp of projectCreatedAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.newProjects += 1
  }

  for (const timestamp of artifactCreatedAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.newArtifacts += 1
  }

  for (const timestamp of runsAt) {
    const point = dailyByKey.get(localDateKey(timestamp))
    if (point && timestamp <= now) point.runs += 1
  }

  for (const event of usageEvents) {
    const point = dailyByKey.get(localDateKey(event.timestamp))
    if (!point || event.timestamp > now) continue
    point.inputTokens += event.inputTokens
    point.cacheTokens += event.cacheTokens
    point.outputTokens += event.outputTokens
    point.totalTokens += event.inputTokens + event.cacheTokens + event.outputTokens
  }

  return {
    now,
    last30Days,
    sessionCreatedAt,
    projectCreatedAt,
    artifactCreatedAt,
    runsAt,
    usageEvents,
    runs,
    totalArtifacts: artifactIds.size
  }
}

export const selectTokenUsageSummary = (
  analytics: TokenUsageAnalytics,
  period: TokenUsagePeriod
): TokenUsageSummary => {
  const start = periodStart(analytics.now, period)
  const usageEvents = analytics.usageEvents.filter((event) =>
    isInPeriod(event.timestamp, start, analytics.now)
  )
  const inputTokens = usageEvents.reduce((total, event) => total + event.inputTokens, 0)
  const cacheTokens = usageEvents.reduce((total, event) => total + event.cacheTokens, 0)
  const outputTokens = usageEvents.reduce((total, event) => total + event.outputTokens, 0)
  const cacheDenominator = inputTokens + cacheTokens
  const futureArtifactCount = analytics.artifactCreatedAt.filter(
    (timestamp) => timestamp > analytics.now
  ).length
  const totalArtifactsThroughNow = analytics.totalArtifacts - futureArtifactCount

  return {
    inputTokens,
    cacheTokens,
    outputTokens,
    totalTokens: inputTokens + cacheTokens + outputTokens,
    cacheShare: cacheDenominator > 0 ? cacheTokens / cacheDenominator : null,
    totalSessions: analytics.sessionCreatedAt.filter((timestamp) => timestamp <= analytics.now)
      .length,
    newConversations: analytics.sessionCreatedAt.filter((timestamp) =>
      isInPeriod(timestamp, start, analytics.now)
    ).length,
    totalProjects: analytics.projectCreatedAt.filter((timestamp) => timestamp <= analytics.now)
      .length,
    newProjects: analytics.projectCreatedAt.filter((timestamp) =>
      isInPeriod(timestamp, start, analytics.now)
    ).length,
    totalArtifacts: totalArtifactsThroughNow,
    newArtifacts:
      period === 'all'
        ? totalArtifactsThroughNow
        : analytics.artifactCreatedAt.filter((timestamp) =>
            isInPeriod(timestamp, start, analytics.now)
          ).length,
    totalRuns: analytics.runsAt.filter((timestamp) => timestamp <= analytics.now).length,
    newRuns: analytics.runsAt.filter((timestamp) => isInPeriod(timestamp, start, analytics.now))
      .length,
    reportedRuns: usageEvents.filter((event) => event.rootRunUsage).length
  }
}

export const tokenUsageMetricValue = (
  point: TokenUsageDailyPoint,
  metric: TokenUsageHeatmapMetric
): number => point[metric]
