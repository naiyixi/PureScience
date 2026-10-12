// 结构内容的摘要（D2 选择指纹里的「内容哈希」那一项）。
//
// 为什么在**渲染层**算：渲染层手里就是用户真正看到的那些字节（预览项的内容），而主进程只在回合准备时
// 才知道这个选择 —— 让主进程去读文件等于换一份来源（可能不是同一个版本）。
//
// 拿不到 WebCrypto 时返回 undefined，**绝不冒充**：这一项在指纹与上下文块里会写成 not-recorded，
// 「没记」与「记了一个值」在指纹上是两种不同的状态（见 src/shared/structure-selection.ts）。

/** 只依赖 digest 这一个方法，便于单测注入（真实现是 `crypto.subtle`）。 */
export type TextDigestSource = {
  digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

/**
 * `sha256:<hex>`；算不出来（环境没有 subtle、或 digest 抛错）时 undefined。
 * 值里带算法前缀：以后换算法时旧值不会被当成同一种摘要比较。
 */
export const sha256Text = async (
  text: string,
  // 省略 = 用环境自带的 WebCrypto；显式 null = 「这个环境没有」那条路（单测要能分别钉住两态）。
  source: TextDigestSource | null | undefined = undefined
): Promise<string | undefined> => {
  const digestSource = source === undefined ? globalThis.crypto?.subtle : (source ?? undefined)
  if (!digestSource) return undefined
  try {
    const digest = await digestSource.digest('SHA-256', new TextEncoder().encode(text))
    return `sha256:${hex(new Uint8Array(digest))}`
  } catch {
    return undefined
  }
}
