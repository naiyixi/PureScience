export const ACTIVITY_GROUP_MCP_SERVER_NAME = 'purescience_activity'
export const BEGIN_ACTIVITY_GROUP_TOOL_NAME = 'begin_activity_group'
export const MAX_ACTIVITY_GROUP_TITLE_LENGTH = 80

// The server was registered as `purescience-activity` before the app settled on a separator-free
// convention, so an event, a stored activity row or a raw input carrying that spelling has to keep
// matching: dropping the old spelling would silently stop recognising activity the user already has.
// app-mcp-names.test.ts pins this literal to the naming module's own legacy list, so it cannot drift
// into a second guess about what the old name was.
const LEGACY_ACTIVITY_GROUP_MCP_SERVER_NAMES = ['purescience-activity']
const ACTIVITY_GROUP_MCP_SERVER_NAMES = [
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  ...LEGACY_ACTIVITY_GROUP_MCP_SERVER_NAMES
]

type ActivityGroupToolEvent = {
  title?: string
  providerToolName?: string
  rawInput?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isActivityGroupServerName = (value: unknown): boolean =>
  typeof value === 'string' && ACTIVITY_GROUP_MCP_SERVER_NAMES.includes(value)

const ACTIVITY_GROUP_TOOL_NAMES = new Set(
  ACTIVITY_GROUP_MCP_SERVER_NAMES.flatMap((server) => [
    `mcp__${server}__${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`,
    `mcp__${server.replaceAll('-', '_')}__${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`,
    `mcp.${server}.${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`,
    `${server}_${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`,
    `${server.replaceAll('-', '_')}_${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`
  ])
)

export const sanitizeActivityGroupTitle = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined

  const collapsed = value.replace(/\s+/gu, ' ').trim()
  const withoutPrefix = collapsed.replace(/^title\s*:\s*/iu, '')
  const withoutWrappingQuotes = withoutPrefix.replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, '')
  const withoutTrailingPunctuation = withoutWrappingQuotes.replace(/[.!?。！？]+$/u, '').trim()

  if (!withoutTrailingPunctuation) return undefined

  return Array.from(withoutTrailingPunctuation)
    .slice(0, MAX_ACTIVITY_GROUP_TITLE_LENGTH)
    .join('')
    .trim()
}

export const isActivityGroupToolEvent = (event: ActivityGroupToolEvent): boolean => {
  const names = [event.providerToolName, event.title]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value))

  if (names.some((name) => ACTIVITY_GROUP_TOOL_NAMES.has(name))) return true
  if (!isRecord(event.rawInput)) return false

  return (
    isActivityGroupServerName(event.rawInput.server) &&
    event.rawInput.tool === BEGIN_ACTIVITY_GROUP_TOOL_NAME
  )
}

export const getActivityGroupTitleFromToolEvent = (
  event: ActivityGroupToolEvent
): string | undefined => {
  if (!isActivityGroupToolEvent(event) || !isRecord(event.rawInput)) return undefined

  const input =
    isRecord(event.rawInput.arguments) && isActivityGroupServerName(event.rawInput.server)
      ? event.rawInput.arguments
      : event.rawInput

  return sanitizeActivityGroupTitle(input.title)
}
