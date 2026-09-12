import { useState } from 'react'
import { FileJson, Upload } from 'lucide-react'

import { isOmicsPreviewManifest, type OmicsPreviewManifest } from '../../../../shared/omics-preview'
import type { OmicsFullRunProposal } from '../../../../shared/omics-full-run'
import { OmicsPreviewPanel } from './OmicsPreviewPanel'

// Launcher for the large-file preview: it never invents a manifest. The manifest comes from running
// the omics-data-preview skill (which reads the file read-only and downsamples honestly), so this
// component either loads that document or explains how to produce it.
export type OmicsPreviewLauncherProps = {
  /** Name of the large file the user asked about (shown in the guidance). */
  sourceName: string
  hosts?: { name: string; executionMode?: 'direct_ssh' | 'slurm' }[]
  engine?: string
  onSubmitFullRun?: (proposal: OmicsFullRunProposal) => void
  /** Dismiss the launcher overlay. */
  onClose?: () => void
  className?: string
}

export function OmicsPreviewLauncher({
  sourceName,
  hosts,
  engine,
  onSubmitFullRun,
  onClose,
  className
}: OmicsPreviewLauncherProps): React.JSX.Element {
  const [manifest, setManifest] = useState<OmicsPreviewManifest | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)

  const handleFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isOmicsPreviewManifest(parsed)) {
        setError(
          '该 JSON 不是有效的预览清单（schemaVersion/字段不符）；请用 omics-data-preview 技能重新生成。'
        )
        setManifest(null)
        return
      }
      setManifest(parsed)
      setError(undefined)
    } catch (cause) {
      setError(`清单读取失败：${cause instanceof Error ? cause.message : String(cause)}`)
      setManifest(null)
    }
  }

  if (manifest) {
    return (
      <div className={`flex flex-col gap-2 ${className ?? ''}`}>
        <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
          <span data-testid="omics-manifest-source">清单已载入：{manifest.path}</span>
          <button
            type="button"
            className="underline"
            onClick={() => {
              setManifest(null)
              setError(undefined)
            }}
          >
            更换清单
          </button>
        </div>
        <OmicsPreviewPanel
          manifest={manifest}
          hosts={hosts}
          engine={engine}
          onSubmitFullRun={onSubmitFullRun}
        />
      </div>
    )
  }

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3 ${className ?? ''}`}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--foreground)]">
        <FileJson className="size-4" aria-hidden="true" /> 大文件预览（先探后算）
        {onClose ? (
          <button
            type="button"
            data-testid="omics-launcher-close"
            className="ml-auto text-xs text-[var(--muted-foreground)] underline"
            onClick={onClose}
          >
            关闭
          </button>
        ) : null}
      </div>
      <p className="text-xs text-[var(--muted-foreground)]" data-testid="omics-launcher-guidance">
        {sourceName} 尚未生成预览清单。请先让助手用 <code>omics-data-preview</code> 技能读取该文件
        （只读结构 + 按预算降采样），再把生成的清单 JSON
        载入这里——本界面不会凭空给出细胞数或降采样结论。
      </p>
      <label className="flex items-center gap-2 text-xs">
        <Upload className="size-3.5" aria-hidden="true" />
        <span>载入预览清单（*.preview.json）</span>
        <input
          type="file"
          accept=".json,application/json"
          data-testid="omics-manifest-input"
          onChange={(event) => {
            void handleFile(event.target.files?.[0])
          }}
        />
      </label>
      {error ? (
        <p role="alert" className="text-xs text-red-400" data-testid="omics-launcher-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
