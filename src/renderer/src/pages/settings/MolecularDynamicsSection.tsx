import { useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLanguage } from '@/i18n'

// Molecular dynamics, stated as what it is: a short vacuum run that proves the engine works end to
// end. Two things this section refuses to do:
//
//   * call the output reproducible. Measured on GROMACS 2025.4 here: 4 threads, `-nt 1`, and
//     `-nt 1 -ntomp 1 -dlb no` all produced different trajectory bytes between runs. The panel says so
//     and shows frames and statistics instead of inviting a digest comparison that would always fail.
//   * imply a solvated simulation. No water box is built; the sentence on screen says vacuum.

type Status = { gmx: string; installed: boolean; missing: string[] }

type RunResult = {
  engineVersion: string
  solvent: string
  forceField: string
  frames: number | null
  atoms: number | null
  steps: number
  temperature: number
  seed: number
  trajectory: { sha256: string; bytes: number }
  finalStructure: { sha256: string; bytes: number }
  statistics: { meanTemperature: number | null; meanPotential: number | null }
}

export function MolecularDynamicsSection(): React.JSX.Element {
  const { t } = useLanguage()
  const [status, setStatus] = useState<Status | undefined>(undefined)
  const [pdbPath, setPdbPath] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RunResult | undefined>(undefined)
  const [failure, setFailure] = useState<{ code: string; message: string } | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await window.api.md.status()
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
      setResult(await window.api.md.run({ pdbPath, steps: 5000, temperature: 300, seed: 37 }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = /engine-not-provisioned/.test(message)
        ? 'engine-not-provisioned'
        : /invalid-input/.test(message)
          ? 'invalid-input'
          : 'run-failed'
      setFailure({ code, message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <section data-slot="molecular-dynamics" className="mt-8">
      <h3 className="text-sm font-semibold text-foreground">{t('settings.engines.md.title')}</h3>
      <p className="mt-0.5 max-w-2xl text-sm leading-5 text-muted-foreground">
        {t('settings.engines.md.intro')}
      </p>

      {status && !status.installed ? (
        <div className="mt-3 rounded-xl border border-border px-3 py-3">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">gromacs-md</Badge>
            <span className="text-xs text-muted-foreground">
              {t('settings.engines.md.notInstalled').replace('{path}', status.gmx)}
            </span>
          </div>
        </div>
      ) : null}

      {status?.installed ? (
        <div className="mt-3 rounded-xl border border-border px-3 py-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label={t('settings.engines.md.pdb')}
              placeholder={t('settings.engines.md.pdb')}
              value={pdbPath}
              onChange={(event) => setPdbPath(event.target.value)}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              onClick={() => void run()}
              disabled={running || pdbPath.trim().length === 0}
            >
              {running ? t('settings.engines.md.running') : t('settings.engines.md.run')}
            </Button>
          </div>

          {failure ? (
            <p className="mt-2 break-all text-xs text-destructive">
              {t('settings.engines.md.failed')
                .replace('{code}', failure.code)
                .replace('{message}', failure.message)}
            </p>
          ) : null}

          {result ? (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs text-muted-foreground">
                {result.engineVersion} · {result.forceField} · {result.solvent} · {result.steps}{' '}
                steps · seed {result.seed}
              </p>
              <p className="text-xs text-foreground">
                {result.frames ?? '—'} frames · {result.atoms ?? '—'} atoms ·{' '}
                {result.statistics.meanTemperature ?? '—'} K ·{' '}
                {result.statistics.meanPotential ?? '—'} kJ/mol
              </p>
              <p className="break-all font-mono text-[11px] text-muted-foreground">
                traj {result.trajectory.sha256.slice(0, 16)}… ({result.trajectory.bytes} B) · final{' '}
                {result.finalStructure.sha256.slice(0, 16)}…
              </p>
              {/* Said on screen, next to the digests, because this is exactly where someone would
                  otherwise assume two identical digests mean two identical runs. */}
              <p className="max-w-2xl text-[11px] leading-4 text-muted-foreground">
                {t('settings.engines.md.repro')}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
