import { useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLanguage } from '@/i18n'

// Inverse folding, as a run rather than as a promise. The panel does three things and nothing else:
// it states whether the engine is provisioned on THIS machine (three paths, listed when missing),
// it runs one design against a structure the user names, and it shows the engine's own numbers next
// to the fingerprint that makes the run recomputable elsewhere.
//
// Deliberately absent: any download control. The engine needs a Python environment this app does not
// provision, and a button that cannot finish would be worse than the sentence saying where it goes.

type Status = {
  engineSrc: string
  weights: string
  envPython: string
  installed: boolean
  missing: string[]
}

type DesignResult = {
  nativeSequence: string
  samples: {
    index: number
    sequence: string
    score?: string | null
    sequenceRecovery?: string | null
  }[]
  weightsSha256: string
  pdbSha256: string
  model: string
  seed: number
  temperature: number
}

type Failure = { code: string; message: string }

export function InverseFoldingSection(): React.JSX.Element {
  const { t } = useLanguage()
  const [status, setStatus] = useState<Status | undefined>(undefined)
  const [pdbPath, setPdbPath] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DesignResult | undefined>(undefined)
  const [failure, setFailure] = useState<Failure | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    // Read once on mount. The await is what keeps this out of the render path; a failed read leaves the
    // section in its unknown state rather than claiming either verdict.
    void (async () => {
      try {
        const next = await window.api.engines.inverseFoldingStatus()
        if (!cancelled) setStatus(next)
      } catch {
        if (!cancelled) setStatus(undefined)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const run = async (): Promise<void> => {
    setRunning(true)
    setFailure(undefined)
    setResult(undefined)
    try {
      setResult(await window.api.engines.runInverseFolding({ pdbPath, num: 2, seed: 37 }))
    } catch (error) {
      // The IPC layer throws the engine's own code in the message; keep the message verbatim so the
      // code the engine reported is what the user reads, not a re-wording of it.
      const message = error instanceof Error ? error.message : String(error)
      const code = /engine-not-provisioned/.test(message)
        ? 'engine-not-provisioned'
        : /invalid-input/.test(message)
          ? 'invalid-input'
          : 'design-failed'
      setFailure({ code, message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <section data-slot="inverse-folding" className="mt-8">
      <h3 className="text-sm font-semibold text-foreground">
        {t('settings.engines.inverseFold.title')}
      </h3>
      <p className="mt-0.5 max-w-2xl text-sm leading-5 text-muted-foreground">
        {t('settings.engines.inverseFold.intro')}
      </p>

      {status && !status.installed ? (
        <div className="mt-3 rounded-xl border border-border px-3 py-3">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">proteinmpnn</Badge>
            <span className="text-xs text-muted-foreground">
              {t('settings.engines.inverseFold.notInstalled').replace('{path}', status.engineSrc)}
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {status.missing.map((path) => (
              <li key={path} className="break-all font-mono text-[11px] text-muted-foreground">
                {path}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {status?.installed ? (
        <div className="mt-3 rounded-xl border border-border px-3 py-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label={t('settings.engines.inverseFold.pdb')}
              placeholder={t('settings.engines.inverseFold.pdb')}
              value={pdbPath}
              onChange={(event) => setPdbPath(event.target.value)}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              onClick={() => void run()}
              disabled={running || pdbPath.trim().length === 0}
            >
              {running
                ? t('settings.engines.inverseFold.running')
                : t('settings.engines.inverseFold.run')}
            </Button>
          </div>

          {failure ? (
            <p className="mt-2 break-all text-xs text-destructive">
              {t('settings.engines.inverseFold.failed')
                .replace('{code}', failure.code)
                .replace('{message}', failure.message)}
            </p>
          ) : null}

          {result ? (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                {result.model} · seed {result.seed} · T {result.temperature}
              </p>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">native</p>
                <p className="break-all font-mono text-[11px] text-foreground">
                  {result.nativeSequence}
                </p>
              </div>
              {result.samples.map((sample) => (
                <div key={sample.index}>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    #{sample.index}
                    {sample.score ? ` · score ${sample.score}` : ''}
                    {sample.sequenceRecovery ? ` · recovery ${sample.sequenceRecovery}` : ''}
                  </p>
                  <p className="break-all font-mono text-[11px] text-foreground">
                    {sample.sequence}
                  </p>
                </div>
              ))}
              <p className="break-all font-mono text-[11px] text-muted-foreground">
                pdb {result.pdbSha256.slice(0, 16)}… · weights {result.weightsSha256.slice(0, 16)}…
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
