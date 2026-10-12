/**
 * D7：**结构产物 → 视图里可见的「引擎 / 输出性质 / 许可」事实**。
 *
 * 这一层的唯一职责是把「这份文件是谁产出的、它算不算测量、它的许可有什么约束」变成**可上屏的行**，
 * 而事实的**唯一来源**是引擎目录（`ENGINE_CATALOG`）—— 视图、面板、提案三处共用它，不各写一份判断。
 *
 * 三条硬规矩：
 *  1. **不猜**。引擎身份只从**应用自己的路径约定**（`…/predictions/<engineId>/…`）里解析，并且必须能在
 *     目录里解析到。解析不到 ⇒ `undefined`（调用方据此**什么也不显示**）。绝不能「按文件名像不像」去认引擎，
 *     也绝不能在没有身份时编一个「未知引擎」的许可出来 —— 那会把「不知道」说成「已核实」。
 *  2. **输出性质必须写明**：`predicted`（预测）绝不许与实验值并列而不标注；`lookup` 是数据库查询
 *     （AlphaFold DB 那类「数据库预测，非实验结构」）；`measured` 才是实验/实测。这条是收尾门。
 *  3. **许可事实随产物走**：许可 id、商用是否受限、权重条款与体积都来自目录，视图只负责显示。
 */

import { ENGINE_CATALOG, type EngineDefinition, type EngineOutputKind } from './engine-catalog'

/** 应用自己的约定：预测产物落在这一层目录下，下一段就是引擎 id。 */
export const STRUCTURE_PREDICTION_DIRECTORY = 'predictions'

/** 视图要显示的一行事实。**措辞留在渲染层**（这里只给结构化事实与枚举）。 */
export type StructureArtifactFact =
  | { kind: 'engine'; engineId: string; engineLabel: string }
  | { kind: 'output'; outputKind: EngineOutputKind; mustBeLabelled: boolean }
  | {
      kind: 'license'
      licenseId: string
      commercialRestricted: boolean
      note?: string
    }
  | { kind: 'weights'; weightBytes: number; onDemandDownload: boolean }

/**
 * 从路径解析引擎 id：只认 `…/predictions/<engineId>/…` 这一种形状，且 id 必须**在目录里**。
 * 返回 `undefined` 有两种成因（都合法）：不是预测产物、或引擎 id 不认识 —— 调用方对两者都**不显示**。
 */
export const engineIdFromPredictionPath = (path: string | undefined): string | undefined => {
  if (!path) return undefined
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0)
  const index = segments.lastIndexOf(STRUCTURE_PREDICTION_DIRECTORY)
  if (index < 0) return undefined
  const candidate = segments[index + 1]
  if (!candidate) return undefined
  return ENGINE_CATALOG.some((engine) => engine.id === candidate) ? candidate : undefined
}

export const engineForPredictionPath = (path: string | undefined): EngineDefinition | undefined => {
  const engineId = engineIdFromPredictionPath(path)
  return engineId ? ENGINE_CATALOG.find((engine) => engine.id === engineId) : undefined
}

/**
 * 事实行（有序，直接给视图用）。`predicted` 的 `mustBeLabelled` 恒为 true —— 这是收尾门的输入，
 * 渲染层据此**必须**把「预测」写出来，而不只是给一个颜色。
 */
export const describeStructureArtifactFacts = (
  engine: EngineDefinition
): StructureArtifactFact[] => [
  { kind: 'engine', engineId: engine.id, engineLabel: engine.label },
  {
    kind: 'output',
    outputKind: engine.outputKind,
    mustBeLabelled: engine.outputKind === 'predicted'
  },
  {
    kind: 'license',
    licenseId: engine.license.id,
    commercialRestricted: engine.license.commercialRestricted,
    ...(engine.license.note ? { note: engine.license.note } : {})
  },
  {
    kind: 'weights',
    weightBytes: engine.requirements.weightBytes,
    onDemandDownload: engine.requirements.onDemandDownload
  }
]

/**
 * 收尾门：这些事实行**必须**把输出性质写出来（`predicted` 的那一行要在），否则不许上屏。
 * 与路由层的 `routeProvenanceIsHonest` 同一条口径 —— 没有「输出性质」这一行的产物说明是不合格的。
 */
export const structureArtifactFactsAreHonest = (facts: readonly StructureArtifactFact[]): boolean =>
  facts.some((fact) => fact.kind === 'output')
