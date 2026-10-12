import { useLanguage } from '@/i18n'
import { Box, Focus, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { GLViewer } from '3dmol'

import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { sha256Text } from '@/lib/text-digest'
import { cn } from '@/lib/utils'

import {
  SELECTION_LABEL_COLORS,
  normalizeStructureSelectionLabel,
  type SelectionLabelColor,
  type StructureSelectionLabel
} from '../../../../../../shared/structure-selection-label'
import {
  structureSelectionFingerprint,
  structureSelectionRangeLabel,
  type StructureSelection
} from '../../../../../../shared/structure-selection'
import {
  parseStructureInstruction,
  structureInstructionParameterLine
} from '../../../../../../shared/structure-instruction'
import {
  STRUCTURE_MEASUREMENT_SCHEMA_VERSION,
  structureMeasurementAtomCount,
  structureMeasurementFingerprint,
  structureMeasurementLabel,
  type StructureMeasurement,
  type StructureMeasurementKind
} from '../../../../../../shared/structure-measurement'

import {
  availableColorSchemes,
  buildStructureSelection,
  chainResidueExtent,
  collectResidueRefs,
  detectStructureFormat,
  looksLikeAlphaFoldModel,
  plddtColorFor,
  measureGeometry,
  resolveStructureSelectionRange,
  structureSelectionFocusSelector,
  structureSelectionSelectors,
  toMeasurementAtom,
  toStructureAtomRef,
  toStructureAtomPick,
  type StructureAtomPick,
  type StructureAtomRef,
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

// D2 选区的可见标记：选中之后用户必须**看得见自己选了什么**（否则「这段是什么」问的是哪一段无从核对）。
// 用主色（brand 蓝 #4D6BFE）与既有风格族，不改默认观感。
const SELECTION_HIGHLIGHT_COLOR = '#4D6BFE'
// D4：用户给这段上的色要**真的画在视图里** —— 否则那个色只是面板上的一个装饰，等于骗人。
// 没上色时落回主色（不写假默认值）。
const selectionHighlight = (
  color: string | undefined
): {
  stick: { radius: number; color: string }
  sphere: { scale: number; color: string }
} => {
  const resolved = color ?? SELECTION_HIGHLIGHT_COLOR
  return {
    stick: { radius: 0.24, color: resolved },
    sphere: { scale: 0.26, color: resolved }
  }
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
  shouldRenderSurface?: () => boolean,
  selection?: StructureSelection,
  // D4：这段的标记色（用户在面板上选的），缺省用主色。
  labelColor?: string
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

  // The selection marker is added AFTER the base style: setStyle replaces the style of the atoms it
  // touches, so a highlight applied earlier would be wiped by any style or color change.
  // One selector per chain: a neighborhood's members can span chains, and one selector can only name
  // residues on a single chain.
  for (const selector of selection ? structureSelectionSelectors(selection) : []) {
    viewer.addStyle(selector, selectionHighlight(labelColor))
  }

  if (shouldZoom) viewer.zoomTo()

  viewer.render()
}

const PdbPreviewViewer = ({
  content,
  name,
  structureId
}: {
  content: string
  name: string
  structureId: string
}): React.JSX.Element => {
  const { t } = useLanguage()
  const setStructureSelection = usePreviewWorkbenchStore((state) => state.setStructureSelection)
  const setStructureSelectionLabel = usePreviewWorkbenchStore(
    (state) => state.setStructureSelectionLabel
  )
  // D4：这个名字/颜色住在 store 里（页签关掉就没了），组件这边只镜像一份给 3D 回调读最新值。
  const storedLabel = usePreviewWorkbenchStore(
    (state) => state.structureSelectionLabels[structureId]
  )
  const setStructureMeasurement = usePreviewWorkbenchStore((state) => state.setStructureMeasurement)
  const viewerElementRef = useRef<HTMLDivElement | null>(null)
  const viewerStateRef = useRef<{ viewer: GLViewer; threeDmol: ThreeDmolModule } | undefined>(
    undefined
  )
  const styleRef = useRef<PdbStyle>('cartoon')
  const colorsRef = useRef<StructureColorScheme>('spectrum')
  const pendingRenderRef = useRef(false)
  const pendingZoomRef = useRef(false)
  const cartoonUnavailableDescriptionId = useId()
  const neighborhoodRadiusInputId = useId()
  const instructionInputId = useId()
  const [selectedStyle, setSelectedStyle] = useState<PdbStyle | undefined>(undefined)
  const [selectedColors, setSelectedColors] = useState<StructureColorScheme | undefined>(undefined)
  const [viewerError, setViewerError] = useState<string | undefined>(undefined)
  // D2：用户在视图里选中的区间。它同时是「上屏的那一句」和「上行给主进程的那一份」。
  // 与**做选择时的那份内容**一起存：内容换了以后旧选择会自动不再生效（派生，而不是在 effect 里
  // 同步改 state —— 那是本仓 error 级门禁 `react-hooks/set-state-in-effect` 明确拦下的写法）。
  const [selection, setSelection] = useState<
    { content: string; value: StructureSelection } | undefined
  >(undefined)
  // D6 导出结果（上屏一句话：成功给文件名；被拒绝明说没写出任何文件；失败明说失败）。
  const [exportStatus, setExportStatus] = useState<'done' | 'refused' | 'failed' | undefined>(
    undefined
  )
  const [exportedName, setExportedName] = useState<string | undefined>(undefined)
  const selectionRef = useRef<StructureSelection | undefined>(undefined)
  // 与 selectionRef 同一形状：3D 的样式回调读 ref，不在渲染路径上读 store（避免重建视图/相机被重置）。
  const labelRef = useRef<StructureSelectionLabel | undefined>(storedLabel)
  const selectionAnchorRef = useRef<StructureAtomRef | undefined>(undefined)
  // 双击同一残基＝把相机对准它（D1 余项：相机/焦点）。用时间戳比较，不额外起定时器。
  const lastClickRef = useRef<{ key: string; at: number } | undefined>(undefined)
  // D3 测量：armed 的种类 + 已经拾起的原子（凑齐 2 个量距离 / 3 个量角度）。
  const [measureKind, setMeasureKind] = useState<StructureMeasurementKind | undefined>(undefined)
  const measurePicksRef = useRef<StructureAtomPick[]>([])
  // 已拾起的原子数（要显示给用户看：量角度要连点三个原子，没有反馈就没人知道点到第几个了）。
  const [measurePickCount, setMeasurePickCount] = useState(0)
  // 命中回调用 ref 读「是否武装」，**不**把 measureKind 放进它的依赖：放进去会让每次武装/解除都换一次
  // 回调身份 ⇒ 视图重建 ⇒ 用户的相机被重置（真机上手会立刻发现）。
  const measureKindRef = useRef<StructureMeasurementKind | undefined>(undefined)
  const [measurement, setMeasurement] = useState<
    { content: string; value: StructureMeasurement } | undefined
  >(undefined)
  // 组件在屏上的期间才允许把选择写进 store（卸载后落一笔等于给一个已经不存在的页签留状态）。
  const mountedRef = useRef(true)
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
      () => viewerStateRef.current?.viewer === viewerState.viewer && styleRef.current === 'surface',
      selectionRef.current,
      labelRef.current?.color
    )
    pendingRenderRef.current = false
    if (shouldZoom) pendingZoomRef.current = false

    return true
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 选择落到三处：组件状态（上屏）、refs（3D 回调里要读最新值）、store（上行给主进程）。
  const publishSelection = useCallback(
    (next: StructureSelection | undefined) => {
      selectionRef.current = next
      // 换区域或清空时 store 都会丢掉名字（名字属于那一段），ref 跟着走，别让旧色留在视图里。
      labelRef.current = undefined
      setSelection(next ? { content, value: next } : undefined)
      setStructureSelection(structureId, next)
    },
    [content, setStructureSelection, structureId]
  )

  // D4：写名字 / 上色 / 移除。store 是唯一来源（空名字与非法颜色都由它统一规范化），
  // 写完**立刻**把颜色画到视图上：用户点一下就该看见，不等下一轮整树重绘。
  const applyLabel = useCallback(
    (name: string, color?: SelectionLabelColor) => {
      if (!selectionRef.current) return
      const next = normalizeStructureSelectionLabel({ name, color })
      labelRef.current = next
      setStructureSelectionLabel(structureId, next)

      const viewerState = viewerStateRef.current
      if (viewerState) {
        applyPdbStyle(
          viewerState.viewer,
          viewerState.threeDmol,
          styleRef.current,
          colorsRef.current,
          false,
          () => false,
          selectionRef.current,
          next?.color
        )
      }
    },
    [setStructureSelectionLabel, structureId]
  )

  // D6：把当前视图导出成 PNG —— **要过审批卡**（这是本条的验收判据：导出触发审批卡），
  // 拒绝时主进程不写任何文件，这里只如实上屏「没有写出任何文件」。
  const exportViewImage = useCallback(async (): Promise<void> => {
    const viewerState = viewerStateRef.current
    if (!viewerState) return
    try {
      const dataUrl = viewerState.viewer.pngURI()
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      // 手动解 base64，不用 `fetch(data:)`：那条路受 CSP 的 connect-src 约束，
      // 被拦下时会表现成一个与导出毫无关系的网络错误（排查方向整个跑偏）。
      const binary = atob(base64)
      const buffer = new ArrayBuffer(binary.length)
      const bytes = new Uint8Array(buffer)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      const fileName = `${name.replace(/\.[^.]+$/, '') || 'structure'}-view.png`
      const result = await window.api.saveBlobFile({
        suggestedName: fileName,
        mimeType: 'image/png',
        data: buffer,
        approval: {
          surface: 'structure-view',
          action: 'export-view-image',
          writes: [{ kind: 'image', fileName, extension: 'png' }],
          // 屏幕上有选区时，导出的图里带着它 —— 卡面要如实说这一句。
          ...(selectionRef.current ? { carriesMarkedRegion: true } : {})
        }
      })
      setExportStatus(
        result.saved ? 'done' : result.refused === 'approval-denied' ? 'refused' : undefined
      )
      if (result.saved) setExportedName(fileName)
    } catch {
      setExportStatus('failed')
    }
  }, [name])

  // 这一帧真正生效的选择/测量：只有还在看的那份内容上的那些才算数。
  const activeSelection = selection?.content === content ? selection.value : undefined
  // 上屏的名字/颜色：只有这一帧真的有选区时才算数（没有选区就没有可命名的东西）。
  const activeLabel = activeSelection ? storedLabel : undefined
  const activeMeasurement = measurement?.content === content ? measurement.value : undefined

  const publishMeasurement = useCallback(
    (next: StructureMeasurement | undefined) => {
      setMeasurement(next ? { content, value: next } : undefined)
      setStructureMeasurement(structureId, next)
    },
    [content, setStructureMeasurement, structureId]
  )

  // D1 余项（相机/焦点）：把相机对准一段选择。用的是**与高亮同一个选择器**（`structureSelectionSelector`），
  // 所以「相机对准的那段」与「界面上写着的那段」永远不会是两个东西。
  const focusSelection = useCallback((target: StructureSelection) => {
    const viewerState = viewerStateRef.current
    if (!viewerState) return
    // The camera takes one selector, so it frames the extent that contains every member.
    viewerState.viewer.zoomTo(structureSelectionFocusSelector(target), 600)
    viewerState.viewer.render()
  }, [])

  // D3：整链与空间邻域两种选择。半径是用户输入（Å），空/非正数就不动作。
  const [neighborhoodRadius, setNeighborhoodRadius] = useState('5')
  // D5：中文口语 → 选择。输入与「实际执行了什么」的那一行都留在组件里（解析结果必须上屏）。
  const [instructionText, setInstructionText] = useState('')
  const [instructionNote, setInstructionNote] = useState<string | undefined>(undefined)

  const publishBuiltSelection = useCallback(
    (build: (digest: string) => StructureSelection) => {
      void sha256Text(content).then((digest) => {
        if (!mountedRef.current) return
        publishSelection(build(digest ?? ''))
        renderCurrentStyle(false)
      })
    },
    [content, publishSelection, renderCurrentStyle]
  )

  // 整链：端点从**视图里真实存在的原子**上取（不在代码里猜 1..N）。
  const selectWholeChain = useCallback(() => {
    const viewerState = viewerStateRef.current
    const reference = selectionRef.current
    if (!viewerState || !reference) return

    const extent = chainResidueExtent(
      viewerState.viewer.selectedAtoms({ chain: reference.chain }),
      reference.chain
    )
    if (!extent) return

    publishBuiltSelection((digest) =>
      buildStructureSelection({
        structureId,
        name,
        format,
        contentDigest: digest,
        start: extent.start,
        end: extent.end,
        view: { style: styleRef.current, colorScheme: colorsRef.current },
        kind: 'chain'
      })
    )
  }, [format, name, publishBuiltSelection, structureId])

  // 邻域：成员表直接来自 3Dmol 的 within 选择器（成员可以跨链）。
  const selectNeighborhood = useCallback(() => {
    const viewerState = viewerStateRef.current
    const reference = selectionRef.current
    if (!viewerState || !reference) return

    const radius = Number(neighborhoodRadius.trim())
    if (!Number.isFinite(radius) || radius <= 0) return

    const members = collectResidueRefs(
      viewerState.viewer.selectedAtoms({
        within: { distance: radius, sel: structureSelectionFocusSelector(reference) }
      })
    )
    if (members.length === 0) return

    // 外沿只用来高亮/对焦：取参考链上的成员范围（`residueStart/End` 的语义见 shared 层注释）。
    const onReferenceChain = members.filter((member) => member.chain === reference.chain)
    const extentSource = onReferenceChain.length > 0 ? onReferenceChain : members
    const start = extentSource.reduce(
      (low, member) => (member.resi < low ? member.resi : low),
      Infinity
    )
    const end = extentSource.reduce(
      (top, member) => (member.resi > top ? member.resi : top),
      -Infinity
    )

    publishBuiltSelection((digest) =>
      buildStructureSelection({
        structureId,
        name,
        format,
        contentDigest: digest,
        start: { chain: reference.chain, resi: start },
        end: { chain: reference.chain, resi: end },
        view: { style: styleRef.current, colorScheme: colorsRef.current },
        kind: 'neighborhood',
        neighborhood: {
          radiusAngstrom: radius,
          ofChain: reference.chain,
          ofStart: reference.residueStart,
          ofEnd: reference.residueEnd
        },
        memberResidues: members
      })
    )
  }, [format, name, neighborhoodRadius, publishBuiltSelection, structureId])

  /**
   * D5：把一句中文落实成选择。
   * 两条铁律：① 解析不出来就**如实上屏拒绝原因**，不做任何"近似"动作；② 解析出来的编号/链必须在
   * **这份结构里真实存在**（问视图要原子），否则拒绝 —— 不把不存在的残基当成"差不多是它"。
   */
  const applyInstruction = useCallback(() => {
    const parsed = parseStructureInstruction(instructionText)
    if (!parsed.ok) {
      setInstructionNote(`未执行 · ${parsed.detail}`)
      return
    }

    const viewerState = viewerStateRef.current
    if (!viewerState) return
    const viewer = viewerState.viewer

    const chainsInViewer = [
      ...new Set(
        viewer
          .selectedAtoms({})
          .map((atom) => toStructureAtomRef(atom)?.chain)
          .filter((chain): chain is string => Boolean(chain))
      )
    ]
    const resolveChain = (requested: string | undefined): string | undefined =>
      requested ? (chainsInViewer.includes(requested) ? requested : undefined) : undefined

    if (parsed.kind === 'chain') {
      const requested = resolveChain(parsed.chain)
      if (parsed.chain && !requested) {
        setInstructionNote(`未执行 · 这份结构里没有链 ${parsed.chain}。`)
        return
      }
      if (!requested && chainsInViewer.length !== 1) {
        setInstructionNote(
          `未执行 · 这份结构有 ${chainsInViewer.length} 条链，请指明是哪一条（例如「A 链整条链」）。`
        )
        return
      }
      const chain = requested ?? chainsInViewer[0]
      const extent = chainResidueExtent(viewer.selectedAtoms({ chain }), chain)
      if (!extent) {
        setInstructionNote(`未执行 · 链 ${chain} 在这份结构里没有原子。`)
        return
      }
      publishBuiltSelection((digest) =>
        buildStructureSelection({
          structureId,
          name,
          format,
          contentDigest: digest,
          start: extent.start,
          end: extent.end,
          view: { style: styleRef.current, colorScheme: colorsRef.current },
          kind: 'chain'
        })
      )
      setInstructionNote(`已执行 · ${structureInstructionParameterLine(parsed)}`)
      return
    }

    const reference = parsed.kind === 'neighborhood' ? parsed.reference : parsed.residue
    const chain =
      resolveChain(reference.chain) ?? (chainsInViewer.length === 1 ? chainsInViewer[0] : undefined)
    if (!chain) {
      setInstructionNote(
        reference.chain
          ? `未执行 · 这份结构里没有链 ${reference.chain}。`
          : `未执行 · 这份结构有 ${chainsInViewer.length} 条链，请指明是哪一条。`
      )
      return
    }

    const residueNumbers: number[] = []
    for (let resi = reference.residueStart; resi <= reference.residueEnd; resi += 1) {
      residueNumbers.push(resi)
    }
    const present = residueNumbers.filter(
      (resi) => viewer.selectedAtoms({ chain, resi }).length > 0
    )
    if (present.length === 0) {
      setInstructionNote(
        `未执行 · 链 ${chain} 上没有残基 ${reference.residueStart}${
          reference.residueEnd === reference.residueStart ? '' : `-${reference.residueEnd}`
        }。`
      )
      return
    }

    if (parsed.kind === 'neighborhood') {
      const members = collectResidueRefs(
        viewer.selectedAtoms({
          within: {
            distance: parsed.radiusAngstrom,
            sel: { chain, resi: `${present[0]}-${present[present.length - 1]}` }
          }
        })
      )
      if (members.length === 0) {
        setInstructionNote('未执行 · 半径内没有找到任何残基。')
        return
      }
      const start = Math.min(
        ...members.filter((member) => member.chain === chain).map((m) => m.resi),
        present[0]
      )
      const end = Math.max(
        ...members.filter((member) => member.chain === chain).map((m) => m.resi),
        present[present.length - 1]
      )
      publishBuiltSelection((digest) =>
        buildStructureSelection({
          structureId,
          name,
          format,
          contentDigest: digest,
          start: { chain, resi: start },
          end: { chain, resi: end },
          view: { style: styleRef.current, colorScheme: colorsRef.current },
          kind: 'neighborhood',
          neighborhood: {
            radiusAngstrom: parsed.radiusAngstrom,
            ofChain: chain,
            ofStart: reference.residueStart,
            ofEnd: reference.residueEnd
          },
          memberResidues: members
        })
      )
      setInstructionNote(
        `已执行 · ${structureInstructionParameterLine(parsed)} · 命中的链 ${[
          ...new Set(members.map((member) => member.chain))
        ].join(',')} · ${members.length} 个残基`
      )
      return
    }

    publishBuiltSelection((digest) =>
      buildStructureSelection({
        structureId,
        name,
        format,
        contentDigest: digest,
        start: { chain, resi: present[0] },
        end: { chain, resi: present[present.length - 1] },
        // 不给 kind：'residue' 与 'range' 由端点推导（相等 ⇒ 单残基），只有整链与邻域必须显式说出来。
        view: { style: styleRef.current, colorScheme: colorsRef.current }
      })
    )
    setInstructionNote(`已执行 · ${structureInstructionParameterLine(parsed)}`)
  }, [instructionText, format, name, publishBuiltSelection, structureId])

  // 内容换了（同一页签换了文件或版本）⇒ 旧选择不再对应屏幕上看到的那份结构：清掉，别留进上下文。
  // 只动 ref 与 store（组件状态由上面的派生收口），所以不需要在 effect 里同步 setState。
  useEffect(() => {
    selectionAnchorRef.current = undefined
    selectionRef.current = undefined
    measurePicksRef.current = []
    setStructureSelection(structureId, undefined)
    setStructureMeasurement(structureId, undefined)
  }, [content, setStructureSelection, setStructureMeasurement, structureId])

  // 3Dmol 的命中回调：点一个残基 = 选它；同链上按 Shift 再点 = 把它拉成连续区间。
  // 摘要在这里按需算（内容就是用户看到的那些字节）：算不出来就记 not-recorded，不编一个值。
  const handleAtomClick = useCallback(
    (atom: unknown, extend: boolean) => {
      const clicked = toStructureAtomRef(atom)

      // 测量中被武装时，点击是「拾一个原子」，不是改选择。
      const armedKind = measureKindRef.current
      if (armedKind) {
        const pick = toStructureAtomPick(atom)
        if (!pick) return
        const needed = structureMeasurementAtomCount(armedKind)
        const picks = [...measurePicksRef.current, pick].slice(0, needed)
        if (picks.length < needed) {
          measurePicksRef.current = picks
          setMeasurePickCount(picks.length)
          return
        }
        measurePicksRef.current = []
        setMeasurePickCount(0)
        const value = measureGeometry(armedKind, picks)
        void sha256Text(content).then((digest) => {
          if (!mountedRef.current) return
          publishMeasurement({
            schemaVersion: STRUCTURE_MEASUREMENT_SCHEMA_VERSION,
            structureId,
            name,
            format,
            contentDigest: digest ?? '',
            kind: armedKind,
            atoms: picks.map(toMeasurementAtom),
            // 坐标不全会得到 undefined ⇒ 如实不写量值（不写 0 冒充）。
            ...(value === undefined ? {} : { value })
          })
        })
        return
      }

      if (!clicked) return
      const range = resolveStructureSelectionRange(selectionAnchorRef.current, clicked, { extend })
      selectionAnchorRef.current = range.anchor
      // 同一个残基在 400 ms 内被点第二次＝双击：选中它并把相机对准它。
      const key = `${clicked.chain}:${clicked.resi}${clicked.icode ?? ''}`
      const previous = lastClickRef.current
      const isRepeat = previous?.key === key && Date.now() - previous.at < 400
      lastClickRef.current = { key, at: Date.now() }

      void sha256Text(content).then((digest) => {
        if (!mountedRef.current) return
        const next = buildStructureSelection({
          structureId,
          name,
          format,
          contentDigest: digest ?? '',
          start: range.start,
          end: range.end,
          view: { style: styleRef.current, colorScheme: colorsRef.current }
        })
        publishSelection(next)
        renderCurrentStyle(false)
        if (isRepeat) focusSelection(next)
      })
    },
    [
      content,
      focusSelection,
      format,
      name,
      publishMeasurement,
      publishSelection,
      renderCurrentStyle,
      structureId
    ]
  )
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
        // D2：点残基就选中它（Shift 再点 = 扩成同链连续区间）。命中回调挂在模型上，
        // 它读的是 refs，所以换表示/配色不会让选择失效。
        viewer.setClickable({}, true, (atom: unknown, _viewer: unknown, event?: unknown) => {
          handleAtomClick(
            atom,
            Boolean(
              event && typeof event === 'object' && (event as { shiftKey?: unknown }).shiftKey
            )
          )
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
  }, [content, format, handleAtomClick, renderCurrentStyle])

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
          {/* D6：导出当前视图（PNG）。过审批卡；被拒绝时下面那行会明说没有写出任何文件。 */}
          <button
            type="button"
            data-slot="structure-export-image"
            className="rounded-sm px-1.5 py-0.5 transition-colors hover:bg-bg-300"
            onClick={() => {
              void exportViewImage()
            }}
          >
            {t('preview.structureExportImage')}
          </button>
          {exportStatus ? (
            <span
              data-slot="structure-export-result"
              data-status={exportStatus}
              className="text-text-300"
            >
              {exportStatus === 'done'
                ? t('preview.structureExportDone', { name: exportedName ?? '' })
                : exportStatus === 'refused'
                  ? t('preview.structureExportRefused')
                  : t('preview.structureExportFailed')}
            </span>
          ) : null}
          {/* D2：选中的区间**上屏**——用户必须能核对「我问 agent 的是哪一段」；指纹放 title 里备查。 */}
          {activeSelection ? (
            <span className="flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[11px] text-text-000">
              <span
                data-slot="structure-selection"
                title={structureSelectionFingerprint(activeSelection)}
              >
                {activeLabel?.name ? `${activeLabel.name} · ` : ''}
                {structureSelectionRangeLabel(activeSelection)}
              </span>
              {/* D4：命名 / 上色 / 检查 / 移除。名字与颜色同住 store，页签关掉一起消失。 */}
              <input
                key={activeLabel?.name ?? 'structure-selection-unnamed'}
                data-slot="structure-selection-label"
                aria-label={t('preview.structureSelectionLabel')}
                placeholder={t('preview.structureSelectionLabelPlaceholder')}
                defaultValue={activeLabel?.name ?? ''}
                className="w-28 rounded-sm bg-bg-200 px-1 py-0.5 text-[11px]"
                onKeyDown={(event) => {
                  if (event.key === 'Enter')
                    applyLabel(event.currentTarget.value, activeLabel?.color)
                }}
                onBlur={(event) => applyLabel(event.currentTarget.value, activeLabel?.color)}
              />
              {SELECTION_LABEL_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  data-slot="structure-selection-color"
                  data-color={color}
                  aria-label={t('preview.structureSelectionColor').replace('{color}', color)}
                  title={color}
                  className={cn(
                    'size-3 rounded-full ring-1 ring-border-300',
                    activeLabel?.color === color && 'ring-2 ring-primary'
                  )}
                  style={{ backgroundColor: color }}
                  onClick={() => applyLabel(activeLabel?.name ?? '', color)}
                />
              ))}
              {activeLabel ? (
                <button
                  type="button"
                  data-slot="structure-selection-label-remove"
                  aria-label={t('preview.structureSelectionLabelRemove')}
                  title={t('preview.structureSelectionLabelRemove')}
                  className="rounded-sm p-0.5 transition-colors hover:bg-bg-300"
                  onClick={() => applyLabel('')}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                data-slot="structure-focus-selection"
                aria-label={t('preview.structureFocusSelection')}
                title={t('preview.structureFocusSelection')}
                className="rounded-sm p-0.5 transition-colors hover:bg-bg-300"
                onClick={() => {
                  const current = selectionRef.current
                  if (current) focusSelection(current)
                }}
              >
                <Focus className="size-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                data-slot="structure-clear-selection"
                aria-label={t('preview.structureClearSelection')}
                title={t('preview.structureClearSelection')}
                className="rounded-sm p-0.5 transition-colors hover:bg-bg-300"
                onClick={() => {
                  selectionAnchorRef.current = undefined
                  publishSelection(undefined)
                  renderCurrentStyle(false)
                }}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ) : null}
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
      {/* D3：整链 / 空间邻域两种选择 —— 都以「当前选区」为出发点，所以没有选区时它们不可动作。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
        <button
          type="button"
          data-slot="structure-select-chain"
          disabled={!activeSelection}
          className={cn(
            'h-6 rounded-md px-2 transition-colors',
            activeSelection
              ? 'text-text-300 hover:bg-bg-300 hover:text-text-000'
              : 'cursor-not-allowed opacity-45'
          )}
          onClick={selectWholeChain}
        >
          {t('preview.structureSelectChain')}
        </button>
        <span className="flex items-center gap-1">
          <label htmlFor={neighborhoodRadiusInputId} className="sr-only">
            {t('preview.structureNeighborhoodRadius')}
          </label>
          <input
            id={neighborhoodRadiusInputId}
            data-slot="structure-neighborhood-radius"
            aria-label={t('preview.structureNeighborhoodRadius')}
            inputMode="decimal"
            value={neighborhoodRadius}
            onChange={(event) => setNeighborhoodRadius(event.target.value)}
            className="h-6 w-14 rounded-md border border-border-300 bg-bg-000 px-2 text-[12px] text-text-000"
          />
          <button
            type="button"
            data-slot="structure-select-within"
            disabled={!activeSelection}
            className={cn(
              'h-6 rounded-md px-2 transition-colors',
              activeSelection
                ? 'text-text-300 hover:bg-bg-300 hover:text-text-000'
                : 'cursor-not-allowed opacity-45'
            )}
            onClick={selectNeighborhood}
          >
            {t('preview.structureSelectWithin')}
          </button>
        </span>
        {/* D3：测量。armed 之后再点原子才是「拾原子」，因此这两个按钮同时是模式开关与状态显示。 */}
        <span className="flex items-center gap-1">
          {(['distance', 'angle'] as const).map((kind) => {
            const armed = measureKind === kind
            return (
              <button
                key={kind}
                type="button"
                data-slot={`structure-measure-${kind}`}
                aria-pressed={armed}
                className={cn(
                  'h-6 rounded-md px-2 transition-colors',
                  armed
                    ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                    : 'text-text-300 hover:bg-bg-300 hover:text-text-000'
                )}
                onClick={() => {
                  const next = armed ? undefined : kind
                  measurePicksRef.current = []
                  setMeasurePickCount(0)
                  measureKindRef.current = next
                  setMeasureKind(next)
                }}
              >
                {kind === 'distance'
                  ? t('preview.structureMeasureDistance')
                  : t('preview.structureMeasureAngle')}
                {armed ? ` ${measurePickCount}/${structureMeasurementAtomCount(kind)}` : ''}
              </button>
            )
          })}
        </span>
        {activeMeasurement ? (
          <span className="flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[11px] text-text-000">
            <span
              data-slot="structure-measurement"
              title={structureMeasurementFingerprint(activeMeasurement)}
            >
              {structureMeasurementLabel(activeMeasurement)}
            </span>
            <button
              type="button"
              data-slot="structure-clear-measurement"
              aria-label={t('preview.structureClearMeasurement')}
              title={t('preview.structureClearMeasurement')}
              className="rounded-sm p-0.5 transition-colors hover:bg-bg-300"
              onClick={() => publishMeasurement(undefined)}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        ) : null}
      </div>
      {/* D5：中文口语 → 选择。解析结果（参数行）或**拒绝原因**必须上屏 —— 否则用户不知道发生了什么。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
        <label htmlFor={instructionInputId} className="sr-only">
          {t('preview.structureInstructionLabel')}
        </label>
        <input
          id={instructionInputId}
          data-slot="structure-instruction"
          aria-label={t('preview.structureInstructionLabel')}
          placeholder={t('preview.structureInstructionPlaceholder')}
          value={instructionText}
          onChange={(event) => setInstructionText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              applyInstruction()
            }
          }}
          className="h-6 min-w-0 flex-1 rounded-md border border-border-300 bg-bg-000 px-2 text-[12px] text-text-000"
        />
        <button
          type="button"
          data-slot="structure-instruction-apply"
          className="h-6 shrink-0 rounded-md px-2 text-text-300 transition-colors hover:bg-bg-300 hover:text-text-000"
          onClick={applyInstruction}
        >
          {t('preview.structureInstructionApply')}
        </button>
        {instructionNote ? (
          <span data-slot="structure-instruction-note" className="min-w-0 truncate">
            {instructionNote}
          </span>
        ) : null}
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
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 border-t border-border-300 bg-bg-000 px-3 py-1.5 text-[11px] leading-4 text-text-300">
        <span>{t('preview.structureHint')}</span>
        <span aria-hidden="true">·</span>
        <span>{t('preview.structureSelectHint')}</span>
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

  // 结构身份：页签 id（同一份文件两次打开是同一个值）+ 显示的版本（同一页签换版本就是另一份内容）。
  const structureId = item.selectedVersionId ? `${item.id}@${item.selectedVersionId}` : item.id

  return (
    <PdbPreviewViewer content={state.preview.content} name={item.name} structureId={structureId} />
  )
}
