// D2：渲染层**唯一**一处「把当前的结构选择读出来给这一回合用」的地方。
//
// 为什么单独成模块、而不把 store 读法散在调用点：上行的那一份必须是**同一份**状态 —— 视图页签在前的
// 那条结构 + 同一会话（用户切走页签后，那段选择已不再是他正在看的东西，此时不该再当作上下文）。
// 判定住在这里，组件与 send 路径都只是调用它。
import type { StructureSelection } from '../../../../shared/structure-selection'
import type { StructureMeasurement } from '../../../../shared/structure-measurement'
import type { StructureSelectionLabel } from '../../../../shared/structure-selection-label'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'

export const turnStructureSelection = (sessionId: string): StructureSelection | undefined =>
  usePreviewWorkbenchStore.getState().activeStructureSelection(sessionId)

/** D4：这一段的名字/颜色（只有真有选区时才算数 —— 名字属于那一段区域）。 */
export const turnStructureSelectionLabel = (
  sessionId: string
): StructureSelectionLabel | undefined =>
  usePreviewWorkbenchStore.getState().activeStructureSelectionLabel(sessionId)

/** D3：这一回合该带上的测量（同样只认在前的结构页签 + 同一会话）。 */
export const turnStructureMeasurement = (sessionId: string): StructureMeasurement | undefined =>
  usePreviewWorkbenchStore.getState().activeStructureMeasurement(sessionId)
