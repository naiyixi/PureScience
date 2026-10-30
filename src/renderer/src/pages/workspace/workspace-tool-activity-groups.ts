import type { PersistedActivityGroup } from '../../../../shared/session-persistence'
import type { ToolActivity } from '@/stores/session-store'

import {
  getNotebookToolSuffix,
  isActivityActive,
  type ConversationItem
} from './workspace-conversation-items'
import { isEditActivity, isSkillActivity } from './workspace-tool-activity-details'
import { hasWebSearchContentEvidence } from './workspace-web-search-details'

type ConversationActivityGroupItem = {
  id: string
  type: 'activity-group'
  createdAt: number
  sortIndex: number
  activities: ToolActivity[]
  activityGroupId?: string
  title?: string
}

type GroupedConversationItem =
  | Extract<ConversationItem, { type: 'message' | 'handoff' | 'plan-activity' | 'config-change' }>
  | ConversationActivityGroupItem
type ActivityExpansionOverrides = Record<string, boolean>
type RenderableActivityEntry = {
  activity: ToolActivity
  activityIndex: number
}

const WEB_SEARCH_PROVIDER_TOOL_NAME = 'websearch'

// A session's transcript carries activities from two places: the hydrated document (every turn the
// session ever ran) and the live run (the one in flight). Picking one over the other drops a whole side:
// preferring the live list erases every finished turn's summary row, which is what a long session is
// supposed to be made of. So they are merged — hydrated first, live appended, deduped by id so a finished
// run that has already been folded into the document is not shown twice.
const mergeActivityLists = <Item extends { id: string }>(
  persisted: readonly Item[] | undefined,
  live: readonly Item[] | undefined
): Item[] | undefined => {
  if (!persisted) return live ? [...live] : undefined
  if (!live) return [...persisted]
  const liveIds = new Set(live.map((item) => item.id))
  return [...persisted.filter((item) => !liveIds.has(item.id)), ...live]
}

// Collapses consecutive activity items into one transcript group between chat messages.
const groupConversationItems = (
  items: ConversationItem[],
  activityGroups: PersistedActivityGroup[] = []
): GroupedConversationItem[] => {
  const groupedItems: GroupedConversationItem[] = []
  const groupsById = new Map(activityGroups.map((group) => [group.id, group]))

  for (const item of items) {
    // Handoff annotations, Plan call records, and config-change dividers are standalone
    // transcript items. Keep their timeline position and prevent them from merging into an
    // adjacent ordinary-tool group.
    if (
      item.type === 'message' ||
      item.type === 'handoff' ||
      item.type === 'plan-activity' ||
      item.type === 'config-change'
    ) {
      groupedItems.push(item)
      continue
    }

    const previousItem = groupedItems[groupedItems.length - 1]
    const activityGroupId = item.activity.activityGroupId
    const declaredGroup = activityGroupId ? groupsById.get(activityGroupId) : undefined

    if (
      previousItem?.type === 'activity-group' &&
      previousItem.activityGroupId === activityGroupId
    ) {
      previousItem.activities.push(item.activity)
      continue
    }

    groupedItems.push({
      id: activityGroupId
        ? `activity-group-${activityGroupId}`
        : `activity-group-${item.activity.id}`,
      type: 'activity-group',
      createdAt: item.createdAt,
      sortIndex: item.sortIndex,
      activities: [item.activity],
      activityGroupId,
      title: declaredGroup?.title
    })
  }

  return groupedItems
}

// Provides a normalized title for detection rules that depend on ACP tool names.
const getTrimmedActivityTitle = (activity: ToolActivity): string => activity.title.trim()

// Detects the synthetic ToolSearch wrapper row that can precede the real search entries.
const isToolSearchWrapperActivity = (activity: ToolActivity): boolean =>
  activity.providerToolName?.trim().toLowerCase() === 'toolsearch' ||
  getTrimmedActivityTitle(activity).toLowerCase() === 'toolsearch'

// Matches Claude's concrete WebSearch tool identity without conflating file-search kinds.
const isProviderWebSearchActivity = (activity: ToolActivity): boolean =>
  activity.providerToolName?.trim().toLowerCase() === WEB_SEARCH_PROVIDER_TOOL_NAME

// Quoted titles are how the current ACP payload represents individual search queries.
const isQuotedActivityTitle = (activity: ToolActivity): boolean =>
  /^["'].+["']$/u.test(getTrimmedActivityTitle(activity))

// Checks prior sibling rows so ToolSearch can classify following quoted fetch rows as searches.
const hasEarlierToolSearchWrapper = (activities: ToolActivity[], activityIndex: number): boolean =>
  activities.slice(0, activityIndex).some((activity) => isToolSearchWrapperActivity(activity))

// ToolSearch can emit concrete search rows as fetch activities or without a tool kind.
const canInferToolSearchResultActivity = (activity: ToolActivity): boolean =>
  activity.toolKind === undefined || activity.toolKind === 'fetch'

// Explicit non-WebSearch provider names are stronger evidence than legacy title heuristics.
const canUseToolSearchProviderInference = (activity: ToolActivity): boolean =>
  activity.providerToolName === undefined ||
  activity.providerToolName.trim() === '' ||
  activity.providerToolName.trim().toLowerCase() === 'toolsearch'

// Allows provisional running searches while requiring payload evidence for completed rows.
const hasToolSearchInferenceEvidence = (activity: ToolActivity): boolean =>
  isActivityActive(activity) || hasWebSearchContentEvidence(activity)

// Classifies concrete WebSearch tools and likely ToolSearch result rows as web searches.
const isSearchActivity = (
  activity: ToolActivity,
  activities: ToolActivity[],
  activityIndex: number
): boolean =>
  isProviderWebSearchActivity(activity) ||
  (canInferToolSearchResultActivity(activity) &&
    canUseToolSearchProviderInference(activity) &&
    isQuotedActivityTitle(activity) &&
    hasToolSearchInferenceEvidence(activity) &&
    hasEarlierToolSearchWrapper(activities, activityIndex))

// Counts detected search activities so headers can summarize searches instead of raw tool calls.
const countSearchActivities = (activities: ToolActivity[]): number =>
  activities.filter((activity, activityIndex) =>
    isSearchActivity(activity, activities, activityIndex)
  ).length

// Coarse activity categories that map many concrete tools onto a few readable header verbs.
type ActivityCategory =
  | 'search'
  | 'toolSearch'
  | 'command'
  | 'fetch'
  | 'read'
  | 'edit'
  | 'skill'
  | 'environment'
  | 'call'
  | 'artifact'
  | 'notebook'
  | 'other'

// Provider tool names that behave like shell/interpreter commands regardless of ACP tool kind.
const COMMAND_PROVIDER_TOOL_NAMES = new Set([
  'python',
  'bash',
  'shell',
  'sh',
  'zsh',
  'node',
  'run_code',
  'jupyter',
  'bashoutput'
])

// Header clauses are emitted in this fixed order so summaries read consistently.
const ACTIVITY_CATEGORY_ORDER: ActivityCategory[] = [
  'command',
  'search',
  'toolSearch',
  'fetch',
  'read',
  'edit',
  'skill',
  'environment',
  'call',
  'artifact',
  'notebook',
  'other'
]

// Reads the lowercased provider tool name used for category matching.
const getNormalizedProviderName = (activity: ToolActivity): string =>
  activity.providerToolName?.trim().toLowerCase() ?? ''

// Assigns one activity to the category that best describes what it did for the header summary.
const categorizeActivity = (
  activity: ToolActivity,
  activities: ToolActivity[],
  activityIndex: number
): ActivityCategory => {
  if (isSearchActivity(activity, activities, activityIndex)) return 'search'
  if (isToolSearchWrapperActivity(activity)) return 'toolSearch'

  const providerName = getNormalizedProviderName(activity)

  // A notebook_execute call is one cell run; summarize it as such instead of a generic tool.
  if (getNotebookToolSuffix(providerName) === 'notebook_execute') return 'notebook'
  if (isSkillActivity(activity)) return 'skill'
  if (providerName === 'save_artifacts' || providerName.includes('artifact')) return 'artifact'
  if (providerName === 'manage_packages' || providerName.includes('package')) return 'environment'
  if (providerName === 'request_network_access' || providerName.startsWith('request_network')) {
    return 'call'
  }
  if (activity.toolKind === 'execute' || COMMAND_PROVIDER_TOOL_NAMES.has(providerName)) {
    return 'command'
  }
  if (isEditActivity(activity)) return 'edit'
  if (activity.toolKind === 'read') return 'read'
  if (activity.toolKind === 'fetch') return 'fetch'

  return 'other'
}

// Builds one natural-language clause (verb + count) for a category present in the group.
const formatCategoryClause = (category: ActivityCategory, count: number): string => {
  switch (category) {
    case 'command':
      return count === 1 ? 'ran a command' : `ran ${count} commands`
    case 'search':
      return count === 1 ? 'ran a search' : `ran ${count} searches`
    case 'toolSearch':
      return count === 1 ? 'ran a tool search' : `ran ${count} tool searches`
    case 'fetch':
      return count === 1 ? 'fetched a page' : `fetched ${count} pages`
    case 'read':
      return count === 1 ? 'read a file' : `read ${count} files`
    case 'edit':
      return count === 1 ? 'edited a file' : `edited ${count} files`
    case 'skill':
      return count === 1 ? 'loaded a skill' : `loaded ${count} skills`
    case 'environment':
      return count === 1 ? 'managed an environment' : 'managed environments'
    case 'call':
      return count === 1 ? 'made a call' : `made ${count} calls`
    case 'artifact':
      return count === 1 ? 'saved a file' : `saved ${count} files`
    case 'notebook':
      return count === 1 ? 'ran a notebook cell' : `ran ${count} notebook cells`
    default:
      return count === 1 ? 'ran a tool' : `ran ${count} tools`
  }
}

// Uppercases the first character so the joined lowercase clauses read as a sentence fragment.
const capitalizeFirst = (value: string): string =>
  value.length > 0 ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value

// Summarizes a group as "Ran 2 commands, loaded a skill, made a call" style category clauses.
const formatActivityGroupTitle = (activities: ToolActivity[], declaredTitle?: string): string => {
  const groupTitle = declaredTitle?.trim()
  if (groupTitle) return groupTitle

  const hasSearchActivities = countSearchActivities(activities) > 0
  const categoryCounts = new Map<ActivityCategory, number>()

  activities.forEach((activity, activityIndex) => {
    // Mirror rendering: drop the synthetic ToolSearch wrapper once concrete searches exist.
    if (hasSearchActivities && isToolSearchWrapperActivity(activity)) return

    const category = categorizeActivity(activity, activities, activityIndex)

    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
  })

  const clauses = ACTIVITY_CATEGORY_ORDER.filter(
    (category) => (categoryCounts.get(category) ?? 0) > 0
  ).map((category) => formatCategoryClause(category, categoryCounts.get(category) ?? 0))

  if (clauses.length === 0) return 'Ran a tool'

  return capitalizeFirst(clauses.join(', '))
}

// Removes ToolSearch wrapper rows from rendering once concrete search rows are available.
const getRenderableActivityEntries = (activities: ToolActivity[]): RenderableActivityEntry[] => {
  const hasSearchActivities = countSearchActivities(activities) > 0

  return activities
    .map((activity, activityIndex) => ({ activity, activityIndex }))
    .filter(({ activity }) => !(hasSearchActivities && isToolSearchWrapperActivity(activity)))
}

// Formats the group header's total visible-step count, flagging any failed steps.
// 一轮的 token 总量，压成一位小数级别：1_234 -> "1.2k"，24_890 -> "25k"，512 -> "512"。
// 与 ComposerContextUsage 的量级写法一致 —— 同屏出现两个「k」写法不同的数字会让人以为两个都不是读数。
const formatTurnTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.round(tokens))
}

const formatStepCount = (activities: ToolActivity[]): string => {
  const activityCount = activities.length
  const stepLabel = activityCount === 1 ? '1 step' : `${activityCount} steps`
  const failedCount = activities.filter((activity) => activity.status === 'failed').length

  return failedCount > 0 ? `${stepLabel} · ${failedCount} failed` : stepLabel
}

// Adds each tool's own runtime, excluding idle gaps between tools in the same group.
const getActivityGroupElapsedMs = (activities: ToolActivity[], now: number): number =>
  activities.reduce(
    (total, activity) =>
      total +
      Math.max(0, (isActivityActive(activity) ? now : activity.updatedAt) - activity.createdAt),
    0
  )

// Keeps short work precise, then switches to compact clock units as the elapsed span grows.
const formatActivityGroupElapsed = (elapsedMs: number): string => {
  const milliseconds = Math.max(0, Math.floor(elapsedMs))
  if (milliseconds < 1000) return `${milliseconds}ms`

  const totalSeconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

// Which activity groups start open. Two facts decide it, and an explicit user toggle beats both:
//
//   · `isNewestTurn` — the group sits after the last user prompt. That is the work the reader is following,
//     so it opens; every earlier turn is settled history and starts collapsed. Without this a forty-turn
//     session opens as one wall of tool rows and the answer the reader came back for is off-screen.
//   · `hasActiveActivity` — a group holding a live tool call never hides it, whatever the turn says. A
//     collapsed group whose only row is still running looks exactly like a group that did nothing.
//
// The rule reads the transcript order, not a clock or a streaming flag: whether a user prompt follows the
// group does not change mid-turn, so a group never collapses under the reader while the turn is streaming.
const resolveActivityGroupExpansion = ({
  override,
  isNewestTurn,
  activities
}: {
  override: boolean | undefined
  isNewestTurn: boolean
  activities: readonly ToolActivity[]
}): boolean => override ?? (isNewestTurn || activities.some(isActivityActive))

export {
  formatActivityGroupElapsed,
  formatActivityGroupTitle,
  formatStepCount,
  formatTurnTokens,
  getActivityGroupElapsedMs,
  getRenderableActivityEntries,
  groupConversationItems,
  isSearchActivity,
  mergeActivityLists,
  resolveActivityGroupExpansion
}
export type {
  ActivityExpansionOverrides,
  ConversationActivityGroupItem,
  GroupedConversationItem,
  RenderableActivityEntry
}
