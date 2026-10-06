import { useLanguage } from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { useComputeStore } from '@/stores/compute-store'
import { cn } from '@/lib/utils'

import {
  ENGINE_CATALOG,
  evaluateEngineAvailability,
  formatWeightSize,
  type EngineAvailability,
  type EngineCopyKey,
  type EngineDefinition
} from '../../../../shared/engine-catalog'
import {
  describeEngineWeightGate,
  weightDownloadPossible,
  weightGateBlocksEngine,
  type EngineWeightGate
} from '../../../../shared/engine-weights'
import { BLOCKED_BY_WEIGHTS_KEY, OUTPUT_KEYS, STATUS_KEYS, WEIGHT_KEYS } from './engine-matrix-copy'

// The engine matrix: which engines can actually serve a request in this build, and why the rest
// cannot. Every fact is read from the same single sources the agent-facing projection uses — the
// shared catalog, the host probe results this panel already loads (`compute:list`) and the weight
// list constant — so the window and the agent can never disagree about the same engine.
//
// Zero new channels, and deliberately no download control: while no engine weight has a published
// checksum the gate refuses every download, and a button that must refuse every target is worse than
// no button (`docs/plan-2026-10-06-IC42-engine-panel.md`). The gate state is stated in words instead.

// The copy-key maps live in `./engine-matrix-copy`: keeping this file exporting only a component
// satisfies Fast Refresh, and their dictionary coverage is asserted without pulling in the React tree.

const EngineRow = ({
  engine,
  availability,
  gate
}: {
  engine: EngineDefinition
  availability: EngineAvailability
  gate: EngineWeightGate
}): React.JSX.Element => {
  const { t } = useLanguage()
  // The catalog hands over a copy *key*; existence in all nine dictionaries is asserted by
  // `engine-matrix-copy.test.ts`, so a typo cannot reach the screen as a raw `engines.…` string.
  const copy = (key: EngineCopyKey): string => (t as (key: string) => string)(key)
  // The weight gate wins when it blocks: "needs your approval" would promise the user that approving
  // enables the engine, which no approval can do while no published checksum is on file.
  const blocked = weightGateBlocksEngine(gate)
  const statusKey = blocked ? BLOCKED_BY_WEIGHTS_KEY : STATUS_KEYS[availability.status]
  const negative = blocked || availability.status === 'unavailable'

  return (
    <div
      data-slot="engine-matrix-row"
      data-engine-id={engine.id}
      data-engine-status={blocked ? 'weights-unavailable' : availability.status}
      data-weight-state={gate.state}
      className="rounded-xl border border-border px-3 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {copy(engine.labelKey)}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">{engine.id}</span>
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
            {copy(engine.summaryKey)}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <Badge variant="outline">{t(OUTPUT_KEYS[engine.outputKind])}</Badge>
          <Badge
            variant="outline"
            className={cn(
              negative
                ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-400'
                : availability.status === 'ready'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
                  : ''
            )}
          >
            {t(statusKey)}
          </Badge>
          {engine.license.commercialRestricted ? (
            <Badge variant="outline">{t('engines.licenseRestricted')}</Badge>
          ) : null}
        </div>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {t(WEIGHT_KEYS[gate.state]).replace(
          '{size}',
          formatWeightSize(engine.requirements.weightBytes)
        )}
      </p>
    </div>
  )
}

export function EngineMatrixSection(): React.JSX.Element {
  const { t } = useLanguage()
  const hosts = useComputeStore((state) => state.hosts)

  // The same two rules the compute skill doc derives, so the two surfaces cannot disagree: a GPU
  // counts only when a probed host reported one, and a host counts only when its probe succeeded.
  const hasComputeHost = hosts.some((host) => host.probeResult?.ok === true)
  const hasGpu = hosts.flatMap((host) => host.probeResult?.gpus ?? []).length > 0
  const downloadPossible = weightDownloadPossible()
  const context = { hasGpu, allowOnDemandDownload: downloadPossible, hasComputeHost }

  return (
    <section data-slot="engine-matrix" className="mt-8">
      <h3 className="text-sm font-semibold text-foreground">{t('settings.enginesTitle')}</h3>
      <p className="mt-0.5 max-w-2xl text-sm leading-5 text-muted-foreground">
        {t('settings.enginesIntro')}
      </p>
      <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
        {t('settings.enginesGpuRule')}
      </p>

      <div className="mt-3 flex flex-col gap-2.5">
        {ENGINE_CATALOG.map((engine) => (
          <EngineRow
            key={engine.id}
            engine={engine}
            availability={evaluateEngineAvailability(engine, context)}
            gate={describeEngineWeightGate(engine, { consent: downloadPossible })}
          />
        ))}
      </div>
    </section>
  )
}
