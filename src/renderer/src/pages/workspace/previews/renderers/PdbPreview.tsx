import { useLanguage } from '@/i18n'
import { Box } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { GLViewer } from '3dmol'

import { cn } from '@/lib/utils'

import {
  availableColorSchemes,
  detectStructureFormat,
  looksLikeAlphaFoldModel,
  plddtColorFor,
  type StructureColorScheme
} from './structure-view'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'

type ThreeDmolModule = typeof import('3dmol')
type PdbStyle = 'cartoon' | 'stick' | 'sphere' | 'surface' | 'line'

// 用户可见文案一律走字典（9 语产品里不该有只懂英文的控件）——label 存 key，渲染时再译。
// `as const` 不是为了不可变：字典的 t() 收的是**键的联合类型**，写成 string 会丢字面量而报 TS2345。
const PDB_STYLE_OPTIONS = [
  { id: 'cartoon', labelKey: 'preview.structureStyleCartoon' },
  { id: 'stick', labelKey: 'preview.structureStyleStick' },
  { id: 'sphere', labelKey: 'preview.structureStyleSphere' },
  { id: 'surface', labelKey: 'preview.structureStyleSurface' },
  { id: 'line', labelKey: 'preview.structureStyleLine' }
] as const

const PROTEIN_RESIDUE_NAMES = new Set([
  'ALA',
  'ARG',
  'ASN',
  'ASP',
  'CYS',
  'GLN',
  'GLU',
  'GLY',
  'HIS',
  'ILE',
  'LEU',
  'LYS',
  'MET',
  'PHE',
  'PRO',
  'SER',
  'THR',
  'TRP',
  'TYR',
  'VAL'
])

const NUCLEIC_ACID_RESIDUE_NAMES = new Set(['A', 'C', 'G', 'T', 'U', 'DA', 'DC', 'DG', 'DT'])

// 非默认配色单独给规格：默认（spectrum）继续走下面的原规格，**默认观感一字不动**；这里只加两条新路。
// chain 用 3Dmol 的 colorscheme；plddt 必须走 colorfunc（它是按 B-factor 的**数值**上色，没有现成 scheme）。
const chainSpec = (rep: 'cartoon' | 'stick' | 'sphere' | 'line'): Record<string, unknown> => {
  if (rep === 'cartoon')
    return {
      cartoon: { color: 'chain' },
      stick: { colorscheme: 'chain', opacity: 0.22, radius: 0.035 }
    }
  if (rep === 'stick') return { stick: { radius: 0.18, colorscheme: 'chain' } }
  if (rep === 'sphere') return { sphere: { scale: 0.32, colorscheme: 'chain' } }
  return { line: { colorscheme: 'chain' } }
}

const plddtSpec = (rep: 'cartoon' | 'stick' | 'sphere' | 'line'): Record<string, unknown> => {
  const colorfunc = (atom: { b: number }): string => plddtColorFor(atom.b)
  if (rep === 'cartoon')
    return { cartoon: { colorfunc }, stick: { colorfunc, opacity: 0.22, radius: 0.035 } }
  if (rep === 'stick') return { stick: { radius: 0.18, colorfunc } }
  if (rep === 'sphere') return { sphere: { scale: 0.32, colorfunc } }
  return { line: { colorfunc } }
}

const PDB_STYLE_SPECS = {
  cartoon: {
    cartoon: { color: 'spectrum' },
    stick: { colorscheme: 'Jmol', opacity: 0.22, radius: 0.035 }
  },
  stick: { stick: { radius: 0.18, colorscheme: 'Jmol' } },
  sphere: { sphere: { scale: 0.32, colorscheme: 'Jmol' } },
  line: { line: { colorscheme: 'Jmol' } }
}

const countPdbAtoms = (content: string): number =>
  content.split(/\r?\n/).filter((line) => line.startsWith('ATOM') || line.startsWith('HETATM'))
    .length

const hasCartoonBackbone = (content: string): boolean => {
  const polymerResidues = new Set<string>()

  for (const line of content.split(/\r?\n/)) {
    if (line.slice(0, 6).trim() !== 'ATOM') continue

    const atomName = line.slice(12, 16).trim().toUpperCase()
    const residueName = line.slice(17, 20).trim().toUpperCase()
    const element = line.slice(76, 78).trim().toUpperCase()
    const residueKey = `${line.slice(21, 22)}:${line.slice(22, 27).trim()}:${residueName}`
    const isProteinBackbone =
      PROTEIN_RESIDUE_NAMES.has(residueName) &&
      atomName === 'CA' &&
      (element === '' || element === 'C')
    const isNucleicAcidBackbone = NUCLEIC_ACID_RESIDUE_NAMES.has(residueName) && atomName === 'P'

    if (isProteinBackbone || isNucleicAcidBackbone) polymerResidues.add(residueKey)

    if (polymerResidues.size >= 2) return true
  }

  return false
}

// Keeps the style switch isolated so changing buttons does not rebuild the 3D model.
const applyPdbStyle = (
  viewer: GLViewer,
  threeDmol: ThreeDmolModule,
  style: PdbStyle,
  colors: StructureColorScheme,
  shouldZoom: boolean,
  shouldRenderSurface?: () => boolean
): void => {
  viewer.removeAllSurfaces()

  if (style === 'surface') {
    viewer.setStyle(
      {},
      {
        cartoon: { color: 'spectrum', opacity: 0.32 },
        stick: { colorscheme: 'Jmol', opacity: 0.12, radius: 0.025 }
      }
    )
    const surface = viewer.addSurface(
      threeDmol.SurfaceType.VDW,
      { opacity: 0.72, colorscheme: 'Jmol' },
      {}
    )

    if (surface && typeof (surface as PromiseLike<unknown>).then === 'function') {
      void (surface as PromiseLike<unknown>).then(
        () => {
          if (!shouldRenderSurface || shouldRenderSurface()) viewer.render()
        },
        (error) => {
          console.error('Failed to render PDB surface', error)
        }
      )
    }
  } else if (colors === 'chain') {
    viewer.setStyle({}, chainSpec(style))
  } else if (colors === 'plddt') {
    viewer.setStyle({}, plddtSpec(style))
  } else {
    viewer.setStyle({}, PDB_STYLE_SPECS[style])
  }

  if (shouldZoom) viewer.zoomTo()

  viewer.render()
}

const PdbPreviewViewer = ({
  content,
  name
}: {
  content: string
  name: string
}): React.JSX.Element => {
  const { t } = useLanguage()
  const viewerElementRef = useRef<HTMLDivElement | null>(null)
  const viewerStateRef = useRef<{ viewer: GLViewer; threeDmol: ThreeDmolModule } | undefined>(
    undefined
  )
  const styleRef = useRef<PdbStyle>('cartoon')
  const colorsRef = useRef<StructureColorScheme>('spectrum')
  const pendingRenderRef = useRef(false)
  const pendingZoomRef = useRef(false)
  const cartoonUnavailableDescriptionId = useId()
  const [selectedStyle, setSelectedStyle] = useState<PdbStyle | undefined>(undefined)
  const [selectedColors, setSelectedColors] = useState<StructureColorScheme | undefined>(undefined)
  const [viewerError, setViewerError] = useState<string | undefined>(undefined)
  const atomCount = useMemo(() => countPdbAtoms(content), [content])
  const supportsCartoon = useMemo(() => hasCartoonBackbone(content), [content])
  // D1：认得出这是什么（mmCIF / AlphaFold 产物），再决定给哪些表示与配色。
  const format = useMemo(() => detectStructureFormat(name, content), [name, content])
  const isAlphaFold = useMemo(() => looksLikeAlphaFoldModel(name, content), [name, content])
  const colorSchemes = useMemo(() => availableColorSchemes(isAlphaFold), [isAlphaFold])
  const colors =
    selectedColors && colorSchemes.includes(selectedColors) ? selectedColors : 'spectrum'
  const defaultStyle: PdbStyle = supportsCartoon ? 'cartoon' : 'stick'
  const style =
    selectedStyle && (supportsCartoon || selectedStyle !== 'cartoon') ? selectedStyle : defaultStyle

  const renderCurrentStyle = useCallback((shouldZoom: boolean): boolean => {
    const viewerState = viewerStateRef.current
    const viewerElement = viewerElementRef.current

    if (
      !viewerState ||
      !viewerElement ||
      viewerElement.clientWidth <= 0 ||
      viewerElement.clientHeight <= 0
    ) {
      return false
    }

    viewerState.viewer.resize()
    applyPdbStyle(
      viewerState.viewer,
      viewerState.threeDmol,
      styleRef.current,
      colorsRef.current,
      shouldZoom,
      () => viewerStateRef.current?.viewer === viewerState.viewer && styleRef.current === 'surface'
    )
    pendingRenderRef.current = false
    if (shouldZoom) pendingZoomRef.current = false

    return true
  }, [])

  useEffect(() => {
    styleRef.current = style
    pendingRenderRef.current = true
    renderCurrentStyle(false)
  }, [renderCurrentStyle, style])

  useEffect(() => {
    colorsRef.current = colors
    pendingRenderRef.current = true
    renderCurrentStyle(false)
  }, [colors, renderCurrentStyle])

  useEffect(() => {
    let canceled = false
    const viewerElement = viewerElementRef.current

    if (!viewerElement) return

    setViewerError(undefined)
    pendingRenderRef.current = true
    pendingZoomRef.current = true
    viewerElement.replaceChildren()

    void import('3dmol')
      .then((threeDmol) => {
        if (canceled) return

        const viewer = threeDmol.createViewer(viewerElement, { backgroundColor: 'white' })
        viewer.addModel(content, format, {
          assignBonds: true,
          noComputeSecondaryStructure: false
        })
        viewerStateRef.current = { viewer, threeDmol }
        renderCurrentStyle(true)
      })
      .catch((error) => {
        console.error('Failed to initialize PDB preview', error)
        if (!canceled) setViewerError(error instanceof Error ? error.message : 'Viewer failed')
      })

    return () => {
      canceled = true
      pendingRenderRef.current = false
      pendingZoomRef.current = false
      viewerStateRef.current?.viewer.clear()
      viewerStateRef.current = undefined
      viewerElement.replaceChildren()
    }
  }, [content, format, renderCurrentStyle])

  useEffect(() => {
    const viewerElement = viewerElementRef.current

    if (!viewerElement || typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => {
      const viewerState = viewerStateRef.current

      if (!viewerState) return
      if (viewerElement.clientWidth <= 0 || viewerElement.clientHeight <= 0) return

      if (pendingRenderRef.current || pendingZoomRef.current) {
        renderCurrentStyle(pendingZoomRef.current)
        return
      }

      viewerState.viewer.resize()
      viewerState.viewer.render()
    })
    resizeObserver.observe(viewerElement)

    return () => {
      resizeObserver.disconnect()
    }
  }, [renderCurrentStyle])

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-300 bg-bg-000 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-text-300">
          <Box className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
          <span className="truncate" title={name}>
            {t('preview.viewerPdb')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[12px] text-text-300">
          <button
            type="button"
            data-slot="structure-reset-view"
            className="h-6 rounded-md px-2 text-[12px] text-text-300 transition-colors hover:bg-bg-300 hover:text-text-000"
            onClick={() => {
              const viewerState = viewerStateRef.current
              if (!viewerState) return
              viewerState.viewer.zoomTo()
              viewerState.viewer.render()
            }}
          >
            {t('preview.structureResetView')}
          </button>
          <span>{t('preview.atomCount').replace('{n}', atomCount.toLocaleString())}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-border-300 bg-bg-000 px-3 py-2">
        <span className="text-[12px] text-text-300">{t('preview.structureStyle')}</span>
        {!supportsCartoon ? (
          <span id={cartoonUnavailableDescriptionId} className="sr-only">
            {t('preview.structureCartoonUnavailable')}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {PDB_STYLE_OPTIONS.map((option) => {
            const isActive = style === option.id
            const isDisabled = option.id === 'cartoon' && !supportsCartoon

            return (
              <button
                key={option.id}
                type="button"
                data-slot={`structure-style-${option.id}`}
                aria-pressed={isActive}
                aria-disabled={isDisabled || undefined}
                aria-describedby={isDisabled ? cartoonUnavailableDescriptionId : undefined}
                title={isDisabled ? t('preview.structureCartoonUnavailable') : t(option.labelKey)}
                className={cn(
                  'h-6 rounded-md px-2.5 text-[12px] text-text-300 transition-colors hover:bg-bg-300 hover:text-text-000',
                  isActive &&
                    'bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground',
                  isDisabled &&
                    'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-text-300'
                )}
                onClick={() => {
                  if (isDisabled) return
                  setSelectedStyle(option.id)
                }}
              >
                {t(option.labelKey)}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-300 bg-bg-000 px-3 py-2">
        <span className="text-[12px] text-text-300">{t('preview.structureColor')}</span>
        <div
          className="flex min-w-0 flex-wrap items-center gap-1"
          data-slot="structure-color-schemes"
        >
          {colorSchemes.map((scheme) => {
            const isActive = colors === scheme
            const label =
              scheme === 'spectrum'
                ? t('preview.structureColorSpectrum')
                : scheme === 'chain'
                  ? t('preview.structureColorChain')
                  : t('preview.structureColorPlddt')
            return (
              <button
                key={scheme}
                type="button"
                aria-pressed={isActive}
                data-slot={`structure-color-${scheme}`}
                title={label}
                className={cn(
                  'h-6 rounded-md px-2.5 text-[12px] text-text-300 transition-colors hover:bg-bg-300 hover:text-text-000',
                  isActive &&
                    'bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground'
                )}
                onClick={() => setSelectedColors(scheme)}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-000">
        {viewerError ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-danger-000">
            {t('preview.structureViewerError').replace('{error}', viewerError)}
          </div>
        ) : null}
        <div
          ref={viewerElementRef}
          className={cn('absolute inset-0', viewerError && 'opacity-20')}
          aria-label={t('preview.structureAriaLabel').replace('{name}', name)}
        />
      </div>
      <div className="flex shrink-0 items-center border-t border-border-300 bg-bg-000 px-3 py-1.5 text-[11px] leading-4 text-text-300">
        {t('preview.structureHint')}
      </div>
    </div>
  )
}

export const PdbPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const state = usePreviewFileContent(item)

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage="PDB couldn't be read for preview"
      />
    )
  }

  if (state.preview.truncated || state.pagination.pageNumber > 1) {
    return <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
  }

  return <PdbPreviewViewer content={state.preview.content} name={item.name} />
}
