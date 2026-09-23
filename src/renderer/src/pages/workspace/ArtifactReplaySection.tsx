import { useState } from 'react'
import { PlayCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useLanguage } from '@/i18n'
import type { ReplayVersionResult } from '../../../../shared/artifact-replay'
import type {
  FileVerdict,
  NotComparableReason,
  ReplayMode,
  ReplayOrigin,
  ReplayVerdict
} from '../../../../shared/replay-verification'

// `artifacts:replay-version` is the same command the window, the remote task API and the agent all
// call — the task API's own comment says a second replay implementation is not allowed. The GUI was the
// one caller missing, so a version could be replayed from a terminal and from a paired device but not
// from the window it was produced in. This section runs that command and lays the whole result out.
//
// Two rules the shared contract insists on, kept here: the MODE and the VERDICT are separate claims (a
// re-run is evidence about reproducibility, re-reading the record is evidence about integrity — neither
// may be reported as the other), and a named refusal is never dressed up as a verdict.

type Translate = ReturnType<typeof useLanguage>['t']

const MODE_KEYS: Record<ReplayMode, string> = {
  're-run': 'ws.replay.mode.reRun',
  'record-integrity': 'ws.replay.mode.recordIntegrity'
}

const VERDICT_KEYS: Record<ReplayVerdict, string> = {
  reproduced: 'ws.replay.verdict.reproduced',
  intact: 'ws.replay.verdict.intact',
  differs: 'ws.replay.verdict.differs',
  changed: 'ws.replay.verdict.changed',
  unverifiable: 'ws.replay.verdict.unverifiable'
}

const ORIGIN_KEYS: Record<ReplayOrigin, string> = {
  executed: 'ws.replay.origin.executed',
  reconstructed: 'ws.replay.origin.reconstructed'
}

const STOPPED_KEYS: Record<string, string> = {
  'no-recorded-code': 'ws.replay.stopped.noRecordedCode',
  'version-unreadable': 'ws.replay.stopped.versionUnreadable',
  'not-configured': 'ws.replay.stopped.notConfigured'
}

const NOT_COMPARABLE_KEYS: Record<NotComparableReason, string> = {
  'no-digest-recorded': 'ws.replay.reason.noDigestRecorded',
  'size-beyond-comparison-bound': 'ws.replay.reason.sizeBeyondBound',
  'app-version-mismatch': 'ws.replay.reason.appVersionMismatch',
  'unsupported-output-kind': 'ws.replay.reason.unsupportedOutputKind'
}

const verdictTone = (verdict: ReplayVerdict): 'default' | 'secondary' | 'destructive' =>
  verdict === 'reproduced' || verdict === 'intact'
    ? 'default'
    : verdict === 'unverifiable'
      ? 'secondary'
      : 'destructive'

const fileLabel = (file: FileVerdict, t: Translate): string => {
  switch (file.status) {
    case 'match':
      return t('ws.replay.file.match')
    case 'differs':
      return t('ws.replay.file.differs')
        .replace('{byte}', String(file.firstDifferingByte))
        .replace('{original}', String(file.originalBytes))
        .replace('{replay}', String(file.replayBytes))
    case 'missing':
      return t('ws.replay.file.missing')
    case 'extra':
      return t('ws.replay.file.extra')
    default:
      return t(NOT_COMPARABLE_KEYS[file.reason] as Parameters<Translate>[0])
  }
}

type ArtifactReplaySectionProps = {
  projectId: string
  appSessionId: string
  artifactId: string
  versionId: string
}

const ArtifactReplaySection = ({
  projectId,
  appSessionId,
  artifactId,
  versionId
}: ArtifactReplaySectionProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ReplayVersionResult | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const runReplay = async (): Promise<void> => {
    setRunning(true)
    setFailure(undefined)
    try {
      const next = await window.api.artifacts.replayVersion({
        projectId,
        appSessionId,
        artifactId,
        versionId
      })
      setResult(next)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : t('ws.replay.failed'))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-3" data-testid="artifact-replay">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="artifact-replay-run"
          disabled={running}
          onClick={() => void runReplay()}
        >
          <PlayCircle aria-hidden="true" />
          {running ? t('ws.replay.running') : t('ws.replay.run')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('ws.replay.hint')}</span>
      </div>

      {failure !== undefined ? (
        <p role="alert" data-testid="artifact-replay-failure" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}

      {result?.stopped !== undefined ? (
        <p data-testid="artifact-replay-stopped" className="text-xs text-muted-foreground">
          {t(
            (STOPPED_KEYS[result.stopped] ??
              'ws.replay.stopped.unknown') as Parameters<Translate>[0]
          )}
        </p>
      ) : null}

      {result !== undefined && result.stopped === undefined ? (
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2" data-testid="artifact-replay-verdict">
            <Badge variant={verdictTone(result.report.verdict)}>
              {t(VERDICT_KEYS[result.report.verdict] as Parameters<Translate>[0])}
            </Badge>
            <span className="text-muted-foreground">
              {t(MODE_KEYS[result.report.mode] as Parameters<Translate>[0])}
            </span>
            <span className="text-muted-foreground">
              {t(ORIGIN_KEYS[result.report.origin] as Parameters<Translate>[0])}
            </span>
          </div>

          <p data-testid="artifact-replay-environment" className="text-muted-foreground">
            {result.environmentLock === 'applied'
              ? t('ws.replay.environment.applied')
              : t('ws.replay.environment.notApplied')}
            {result.environmentManifestChecksum !== undefined
              ? ` · ${t('ws.replay.manifestChecksum').replace(
                  '{checksum}',
                  result.environmentManifestChecksum
                )}`
              : ''}
          </p>

          <p data-testid="artifact-replay-execution" className="text-muted-foreground">
            {'skipped' in result.execution
              ? t('ws.replay.execution.skipped')
              : `${t('ws.replay.execution.summary')
                  .replace('{via}', result.execution.via)
                  .replace('{exitCode}', String(result.execution.exitCode ?? '—'))
                  .replace('{durationMs}', String(result.execution.durationMs))}${
                  result.execution.timedOut ? ` · ${t('ws.replay.execution.timedOut')}` : ''
                }`}
          </p>

          {result.report.reasons.length > 0 ? (
            <div data-testid="artifact-replay-reasons">
              <p className="font-medium">{t('ws.replay.reasons')}</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
                {result.report.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div data-testid="artifact-replay-files">
            <p className="font-medium">{t('ws.replay.files')}</p>
            {result.report.files.length === 0 ? (
              <p className="mt-0.5 text-muted-foreground">{t('ws.replay.filesEmpty')}</p>
            ) : (
              <ul className="mt-0.5 space-y-0.5">
                {result.report.files.map((file) => (
                  <li key={file.path} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono break-all">{file.path}</span>
                    <span className="text-muted-foreground">{fileLabel(file, t)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export { ArtifactReplaySection }
