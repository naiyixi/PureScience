// Installing several marketplace packages at once is orchestration, not a new install path: every item
// still goes through the same prepare (fetch + validate) and install calls the single-item flow uses, so
// a batch can never install something the single flow would have refused to.
//
// Two rules make it safe to run unattended:
//   * every item is prepared first, and only prepared-ready items are installed — an item that needs
//     attention (validation errors, a package whose files changed locally since import) is reported by
//     name and left alone rather than silently overwritten;
//   * one failure never aborts the rest: each item reports its own outcome, so a batch that partly
//     succeeded says exactly which part.
export type MarketplaceBatchItem = {
  specialistId: string
  name: string
}

export type MarketplaceBatchOutcome =
  | { specialistId: string; name: string; status: 'installed' }
  | { specialistId: string; name: string; status: 'updated' }
  | { specialistId: string; name: string; status: 'skipped'; reason: string }
  | { specialistId: string; name: string; status: 'failed'; reason: string }

export type MarketplaceBatchSummary = {
  outcomes: readonly MarketplaceBatchOutcome[]
  installed: number
  updated: number
  skipped: number
  failed: number
}

export type MarketplaceBatchPorts<PreparedPackage> = {
  // Fetches and validates a package without installing it (the single flow's preview step).
  prepare: (item: MarketplaceBatchItem) => Promise<PreparedPackage>
  // Whether the prepared package may be installed, and why not when it may not.
  readiness: (prepared: PreparedPackage) => { ready: boolean; reason?: string }
  // Whether installing replaces an already-installed package (reported as `updated`).
  isUpdate: (prepared: PreparedPackage) => boolean
  // Installs a prepared package. Rejections become that item's named failure.
  install: (prepared: PreparedPackage) => Promise<void>
  onOutcome?: (outcome: MarketplaceBatchOutcome) => void
}

export const runMarketplaceBatch = async <PreparedPackage>(
  items: readonly MarketplaceBatchItem[],
  ports: MarketplaceBatchPorts<PreparedPackage>
): Promise<MarketplaceBatchSummary> => {
  const outcomes: MarketplaceBatchOutcome[] = []

  for (const item of items) {
    let prepared: PreparedPackage
    try {
      prepared = await ports.prepare(item)
    } catch (error) {
      const outcome: MarketplaceBatchOutcome = {
        specialistId: item.specialistId,
        name: item.name,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      }
      outcomes.push(outcome)
      ports.onOutcome?.(outcome)
      continue
    }

    const readiness = ports.readiness(prepared)
    if (!readiness.ready) {
      const outcome: MarketplaceBatchOutcome = {
        specialistId: item.specialistId,
        name: item.name,
        status: 'skipped',
        reason: readiness.reason ?? 'not-ready'
      }
      outcomes.push(outcome)
      ports.onOutcome?.(outcome)
      continue
    }

    try {
      await ports.install(prepared)
      const outcome: MarketplaceBatchOutcome = {
        specialistId: item.specialistId,
        name: item.name,
        status: ports.isUpdate(prepared) ? 'updated' : 'installed'
      }
      outcomes.push(outcome)
      ports.onOutcome?.(outcome)
    } catch (error) {
      const outcome: MarketplaceBatchOutcome = {
        specialistId: item.specialistId,
        name: item.name,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      }
      outcomes.push(outcome)
      ports.onOutcome?.(outcome)
    }
  }

  return {
    outcomes,
    installed: outcomes.filter((outcome) => outcome.status === 'installed').length,
    updated: outcomes.filter((outcome) => outcome.status === 'updated').length,
    skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
    failed: outcomes.filter((outcome) => outcome.status === 'failed').length
  }
}
