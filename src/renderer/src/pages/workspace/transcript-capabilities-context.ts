import { createContext, useContext } from 'react'

// Why a context instead of a prop: "can branch into a new session" flips on every turn boundary
// (running → idle), and the transcript used to hand it to every row. A prop that changes for the whole
// transcript re-renders every settled row once per turn, which is exactly the growth curve measured in
// docs/plan-2026-11-05-transcript-render-architecture.md. Context keeps the value out of the row's props
// so a settled row's prop tuple stays stable; only the small control that reads it re-renders.
export type TranscriptCapabilities = {
  canBranchInNewSession: boolean
}

export const DEFAULT_TRANSCRIPT_CAPABILITIES: TranscriptCapabilities = {
  canBranchInNewSession: false
}

export const TranscriptCapabilitiesContext = createContext<TranscriptCapabilities>(
  DEFAULT_TRANSCRIPT_CAPABILITIES
)

export const useTranscriptCapabilities = (): TranscriptCapabilities =>
  useContext(TranscriptCapabilitiesContext)
