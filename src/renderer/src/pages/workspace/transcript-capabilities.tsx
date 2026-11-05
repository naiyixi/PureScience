import { useMemo, type ReactNode } from 'react'

import { TranscriptCapabilitiesContext } from './transcript-capabilities-context'

// Provider only: the context object and its hook live in transcript-capabilities-context.ts so this file
// exports nothing but a component (react-refresh).
export const TranscriptCapabilitiesProvider = ({
  canBranchInNewSession,
  children
}: {
  canBranchInNewSession: boolean
  children: ReactNode
}): React.JSX.Element => {
  const value = useMemo(() => ({ canBranchInNewSession }), [canBranchInNewSession])
  return (
    <TranscriptCapabilitiesContext.Provider value={value}>
      {children}
    </TranscriptCapabilitiesContext.Provider>
  )
}
