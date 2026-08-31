// App-owned structured clarification coordinator (ACP elicitation).
//
// When an agent issues an `elicitation/create` request (form mode), the broker validates the
// schema against hard bounds, projects it for the renderer, and blocks the agent's tool call
// until the user answers, declines, or cancels — the same blocking contract the permission
// broker uses. The broker owns zero UI: it only resolves the pending promise once the renderer
// (or a timeout/cancel path) settles it.

import type {
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  ElicitationSchema
} from '@agentclientprotocol/sdk'

import {
  ELICITATION_MAX_CHOICES,
  ELICITATION_MAX_FIELD_DESCRIPTION_LENGTH,
  ELICITATION_MAX_FIELD_LABEL_LENGTH,
  ELICITATION_MAX_FIELDS,
  ELICITATION_MAX_MESSAGE_LENGTH,
  type ElicitationAnswer,
  type ElicitationFieldView,
  type ElicitationRequestView
} from '../shared/elicitation'

type PendingElicitation = {
  view: ElicitationRequestView
  settle: (response: CreateElicitationResponse) => boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value.map((item) => item.trim()).filter((item) => item.length > 0)
    : undefined

const isStringProperty = (
  property: ElicitationPropertySchema
): property is ElicitationPropertySchema & { type: 'string' } => property.type === 'string'

// Projects a validated property into the renderer view. Single-select strings carry `enum`
// choices; multi-select arrays carry `items.enum` choices. Everything else is free-form.
const projectField = (
  key: string,
  property: ElicitationPropertySchema,
  required: boolean
): ElicitationFieldView | undefined => {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > ELICITATION_MAX_FIELD_LABEL_LENGTH
  ) {
    return undefined
  }
  let label = key
  let description: string | undefined
  if (typeof property.title === 'string' && property.title.trim().length > 0) {
    label = property.title.trim().slice(0, ELICITATION_MAX_FIELD_LABEL_LENGTH)
  }
  if (typeof property.description === 'string') {
    description = property.description.trim().slice(0, ELICITATION_MAX_FIELD_DESCRIPTION_LENGTH)
  }

  if (property.type === 'string') {
    const choices = asStringArray(property.enum) ?? asStringArray(property.oneOf)
    if (choices && choices.length > ELICITATION_MAX_CHOICES) return undefined
    return { key, kind: 'string', label, required, choices, description }
  }
  if (property.type === 'number' || property.type === 'integer' || property.type === 'boolean') {
    return { key, kind: property.type, label, required, description }
  }
  if (property.type === 'array') {
    const items = isRecord(property.items) ? property.items : undefined
    const choices =
      items && isStringProperty(items as ElicitationPropertySchema)
        ? asStringArray((items as { enum?: unknown }).enum)
        : undefined
    if (choices && choices.length > ELICITATION_MAX_CHOICES) return undefined
    return { key, kind: 'array', label, required, choices, description }
  }
  return undefined
}

const projectFormView = (request: CreateElicitationRequest): ElicitationRequestView | undefined => {
  if (request.mode !== 'form') return undefined
  const schema = request.requestedSchema as ElicitationSchema | undefined
  if (!schema || schema.type !== 'object' || !isRecord(schema.properties)) return undefined

  const entries = Object.entries(schema.properties)
  if (entries.length === 0 || entries.length > ELICITATION_MAX_FIELDS) return undefined

  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === 'string') : []
  )
  const fields: ElicitationFieldView[] = []
  for (const [key, property] of entries) {
    if (typeof property !== 'object' || property === null) return undefined
    const field = projectField(key, property as ElicitationPropertySchema, required.has(key))
    if (!field) return undefined
    fields.push(field)
  }
  return { id: '', sessionId: '', message: '', fields }
}

export type ElicitationBrokerDependencies = {
  // Broadcasts a pending clarification to the renderer (main → renderer IPC).
  emitRequest: (request: ElicitationRequestView) => void
  // Called when the agent notifies that an elicitation lifecycle completed on its side.
  onComplete?: (elicitationId: string) => void
  now?: () => number
  // Optional wall-clock bound on how long a pending elicitation may stay unanswered.
  // The agent's own session keeps running, so a generous default applies only when set.
  requestTimeoutMs?: number
}

export class ElicitationBroker {
  private readonly pending = new Map<string, PendingElicitation>()
  private readonly emitRequest: (request: ElicitationRequestView) => void
  private readonly onComplete?: (elicitationId: string) => void
  private readonly now: () => number
  private readonly requestTimeoutMs: number | undefined
  private sequence = 0

  constructor(deps: ElicitationBrokerDependencies) {
    this.emitRequest = deps.emitRequest
    this.onComplete = deps.onComplete
    this.now = deps.now ?? Date.now
    this.requestTimeoutMs = deps.requestTimeoutMs
  }

  get pendingCount(): number {
    return this.pending.size
  }

  listPending(): ElicitationRequestView[] {
    return [...this.pending.values()].map((entry) => entry.view)
  }

  // Handles an agent `elicitation/create` request. Blocks until the user settles the card.
  // Returns the response the agent expects: accept(content) / decline / cancel. Fail-closed:
  // any validation problem or lifecycle race yields `cancel` so the agent never waits forever.
  async requestElicitation(
    request: CreateElicitationRequest,
    sessionId: string
  ): Promise<CreateElicitationResponse> {
    const view = projectFormView(request)
    if (!view) {
      return { action: 'cancel' }
    }
    const message =
      typeof request.message === 'string'
        ? request.message.trim().slice(0, ELICITATION_MAX_MESSAGE_LENGTH)
        : ''
    if (!message) return { action: 'cancel' }

    const id = `elicitation-${this.now()}-${++this.sequence}`
    const fullView: ElicitationRequestView = {
      id,
      sessionId,
      message,
      fields: view.fields
    }

    return new Promise<CreateElicitationResponse>((resolve) => {
      let settled = false
      const settle = (response: CreateElicitationResponse): boolean => {
        if (settled) return false
        settled = true
        this.pending.delete(id)
        resolve(response)
        return true
      }
      this.pending.set(id, { view: fullView, settle })

      if (this.requestTimeoutMs !== undefined) {
        setTimeout(() => {
          settle({ action: 'cancel' })
        }, this.requestTimeoutMs).unref?.()
      }
      this.emitRequest(fullView)
    })
  }

  // Renderer → main: settles a pending elicitation.
  respondElicitation(
    elicitationId: string,
    action: 'accept' | 'decline' | 'cancel',
    answers?: ElicitationAnswer
  ): boolean {
    const entry = this.pending.get(elicitationId)
    if (!entry) return false
    if (action === 'accept') {
      return entry.settle({ action: 'accept', content: answers ?? {} })
    }
    return entry.settle({ action })
  }

  // Agent → main: the agent notified that this elicitation's lifecycle is over on its side
  // (e.g. it cancelled its own request). Completes any pending entry as cancelled.
  observeElicitationComplete(notification: CompleteElicitationNotification): void {
    const id = notification.elicitationId
    const entry = this.pending.get(id)
    if (entry) entry.settle({ action: 'cancel' })
    this.onComplete?.(id)
  }

  // Session teardown / explicit cancel: fail closed any pending elicitations for a session.
  cancelSessionElicitations(sessionId: string): void {
    for (const entry of this.pending.values()) {
      if (entry.view.sessionId === sessionId) {
        entry.settle({ action: 'cancel' })
      }
    }
  }
}

export const ELICITATION_BROKER_INTERNAL = { projectFormView }
