/**
 * D4：**用户给选区起的名字**（可选带一个标记色）。
 *
 * 为什么名字**不进** Selection 的指纹：指纹回答的是「这是哪一段区域」（可复算、跨机器一致）。
 * 名字是人对它的称呼 —— 同一段区域今天叫「活性位点」、明天叫「结合口袋」，指纹**必须**一样，
 * 否则引用链会在同一段区域上断成两条。所以名字与区域**分开存**，引用的时候（上下文块 / 观察日志 /
 * 面板 / 导出）两样并列给出：区域给机器复算，名字给人对齐。
 *
 * 这一层是纯函数、无 IO：判定（名字合不合法、颜色可不可用、上屏那句话长什么样）全部可单测，
 * 渲染层与主进程共用同一份判据（名字要进模型上下文，主进程侧必须能再规范化一次不信输入）。
 */

/** 名字长度上限：它是上屏与进上下文的一段短文本，不是自由正文。 */
export const SELECTION_LABEL_MAX_LENGTH = 40

/**
 * 可选的标记色：**闭集**。渲染层要用它给结构上色、导出要把颜色带走，
 * 两边都必须能校验 —— 拿任意字符串当颜色会在 3Dmol 那一侧静默失效。
 * 主色是本仓的品牌蓝（第一个即默认）。
 */
export const SELECTION_LABEL_COLORS = [
  '#4D6BFE',
  '#E5484D',
  '#F5A524',
  '#30A46C',
  '#8E4EC6'
] as const

export type SelectionLabelColor = (typeof SELECTION_LABEL_COLORS)[number]

/**
 * 名字与颜色**各自可缺**：计划里「命名」与「上色」是两件事（有人只想给口袋换个色以便区分，
 * 并不想给它起名）。缺省就是缺省 —— 不写假默认值冒充用户填过。
 * 两样都缺 ⇒ 没有标签（见下面的规范化），因为那时它既不是名字也不是颜色。
 */
export type StructureSelectionLabel = {
  name?: string
  /** 缺省表示用默认高亮色。 */
  color?: SelectionLabelColor
}

export const isSelectionLabelColor = (value: unknown): value is SelectionLabelColor =>
  typeof value === 'string' && (SELECTION_LABEL_COLORS as readonly string[]).includes(value)

/**
 * 规范化（渲染层与主进程共用，主进程侧当作**不信输入**再跑一次）：
 *  - 首尾空白裁掉、内部换行/制表折成单空格（名字是**一行**）；
 *  - 控制字符去掉；
 *  - `<` `>` **中和成同样一眼能认出的 `‹›`**：名字会被拼进 `purescience_structure_context`
 *    那一族标记块里，留着 ASCII 尖括号的话，一个名字就能改写块的框架（这不是保洁问题，是上下文注入面）。
 *    用形近的 `‹›` 而不是直接删掉：直接删会把 `cat</tag>` 粘成 `cat/tag`，读的人（和模型）会以为
 *    用户真写了那么一串；换形近字符则既拼不出标签，又保住用户原话可读。
 *  - 超长按上限**截断**（名字是短文本；截断比让整个标签作废更符合预期，且截断是可见的）；
 *  - **名字与颜色都为缺** ⇒ `undefined`：**不造空标签**（「没命名」与「命名成空」必须是同一件事，
 *    否则界面上会出现一个点不掉、也说不清是什么的空标签）；
 *    名字为缺但颜色合法 ⇒ **留下颜色**（只想上色不想起名是一种正常用法）；颜色非法而名字为空 ⇒
 *    真的什么都不剩 ⇒ `undefined`。
 */
export const normalizeStructureSelectionLabel = (
  input: unknown
): StructureSelectionLabel | undefined => {
  if (!input || typeof input !== 'object') return undefined
  const record = input as { name?: unknown; color?: unknown }
  const rawName = typeof record.name === 'string' ? record.name : ''
  const collapsed = rawName
    // eslint-disable-next-line no-control-regex -- 控制字符正是要清掉的东西
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\s+/g, ' ')
    .trim()

  const name =
    collapsed.length > SELECTION_LABEL_MAX_LENGTH
      ? collapsed.slice(0, SELECTION_LABEL_MAX_LENGTH)
      : collapsed
  const color = isSelectionLabelColor(record.color) ? record.color : undefined

  if (name.length === 0 && color === undefined) return undefined
  return {
    ...(name.length > 0 ? { name } : {}),
    ...(color !== undefined ? { color } : {})
  }
}

/**
 * 进上下文块的一句话。名字是**用户自己的词**，逐字给出（不翻译、不改写）——
 * agent 要靠它对齐「你说的那个活性位点」到底是哪一段；区域本身在同一个块的 JSON 里。
 */
export const structureSelectionLabelSentence = (label: StructureSelectionLabel): string =>
  label.name === undefined ? '' : `用户把这段命名为「${label.name}」`
