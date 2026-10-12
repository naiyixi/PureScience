// D2: 把「用户在视图里选中的结构区间」变成一段进**会话上下文**的块。
//
// 三条要点：
//  1. 渲染层送来的选择是**不可信输入** ⇒ 这里先用 shared 层的规范化重建一次；重建不出来就**不注入**
//     （于是「没有选择」与「选择不合法」都不会被当成上下文，普通回合逐字节不变）。
//  2. 这段文字走 prepared.content（既有 notice 缝），**绝不进 request.text** —— 那是记录用户说了什么
//     的字段，把应用文本写进去等于伪造用户的话。
//  3. 纯函数、无 IO：判定（有没有选择 / 选择是否成立 / 块长什么样）全部可单测。
import { normalizeStructureSelectionLabel } from '../../shared/structure-selection-label'
import type { AcpPromptRequest } from '../../shared/acp'
import {
  buildStructureContextBlock,
  normalizeStructureSelection
} from '../../shared/structure-selection'
import {
  buildStructureMeasurementBlock,
  normalizeStructureMeasurement
} from '../../shared/structure-measurement'

/** 没有选择、或选择不合格时返回 ''（调用方据此保持内容不变）。 */
export const structureSelectionNotice = (
  request: Pick<AcpPromptRequest, 'structureSelection' | 'structureSelectionLabel'>
): string => {
  const selection = normalizeStructureSelection(request.structureSelection)
  if (!selection) return ''
  // 名字与区域一样是**渲染层送来的不可信输入**：这里再规范化一次（截断/折行/中和尖括号都在那一层），
  // 规范不出来就当没名字 —— 绝不把一段原样文本拼进标记块。
  return buildStructureContextBlock(
    selection,
    normalizeStructureSelectionLabel(request.structureSelectionLabel)
  )
}

/** D3 测量：同一条口径 —— 重建不出来就不注入（半截的测量比没有更糟）。 */
export const structureMeasurementNotice = (
  request: Pick<AcpPromptRequest, 'structureMeasurement'>
): string => {
  const measurement = normalizeStructureMeasurement(request.structureMeasurement)
  return measurement ? buildStructureMeasurementBlock(measurement) : ''
}
