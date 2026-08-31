// Structured clarification (ACP elicitation) contract shared by main, preload, and renderer.
//
// Agents request structured user input through the ACP `elicitation/create` request with a
// form-mode schema (primitive-typed properties: string / number / integer / boolean / array of
// strings). The app owns the blocking UX: the renderer shows a multi-question card, the user
// answers, and the response (`accept` with content, `decline`, or `cancel`) is returned to the
// agent. This file carries the renderer-facing projection of a pending elicitation plus the IPC
// channel names, keeping bounds in one place.

export type ElicitationPropertyKind = 'string' | 'number' | 'integer' | 'boolean' | 'array'

// One form field as shown to the user. `choices` is present for single-select strings
// (JSON Schema enum) and multi-select arrays (items enum); otherwise the field is free-form.
export type ElicitationFieldView = {
  key: string
  kind: ElicitationPropertyKind
  label: string
  required: boolean
  choices?: string[]
  description?: string
}

// Renderer-facing projection of a pending agent clarification request.
export type ElicitationRequestView = {
  id: string
  sessionId: string
  // The agent's human-readable message describing what input is needed.
  message: string
  fields: ElicitationFieldView[]
}

export type ElicitationContentValue = string | number | boolean | string[]

export type ElicitationAnswer = Record<string, ElicitationContentValue>

// Renderer → main response for a pending elicitation.
export type ElicitationRespondRequest = {
  elicitationId: string
  // 'accept' carries the user's answers; 'decline' means the user refused to answer;
  // 'cancel' means the user dismissed the card without answering.
  action: 'accept' | 'decline' | 'cancel'
  answers?: ElicitationAnswer
}

// IPC channel names.
export const ELICITATION_CHANNEL_REQUEST = 'acp:elicitation-request'
export const ELICITATION_CHANNEL_RESPOND = 'acp:respond-elicitation'

// Hard bounds (fail closed; oversized agent requests are declined, not truncated).
export const ELICITATION_MAX_MESSAGE_LENGTH = 2000
export const ELICITATION_MAX_FIELDS = 8
export const ELICITATION_MAX_CHOICES = 12
export const ELICITATION_MAX_FIELD_LABEL_LENGTH = 120
export const ELICITATION_MAX_FIELD_DESCRIPTION_LENGTH = 400
// Answers are bounded per field to keep the wire and the agent prompt small.
export const ELICITATION_MAX_ANSWER_LENGTH = 2000
export const ELICITATION_MAX_MULTI_SELECT_ITEMS = 20
