/**
 * 图上读到的库号 → 库里的**真实记录**（U4-b）。
 *
 * 单开一个模块是为了让真机读数走的就是生产代码：探针与装配点呼叫同一个函数，而不是各写一份。
 * 请求走主进程既有的受管取数路径（`proxy-runtime` 在 fetch 之前把应用与系统的代理设置应用好），
 * 带显式超时；失败一律以**具名**的 `unavailable` 回去并带上下一步 —— 读图**不会**因为查库失败而失败。
 */
import { accessionLookupUrl, shapeAccessionLookup } from '../../shared/figure-accession'
import type { AccessionLookupOutcome } from '../../shared/figure-accession'
import type { FigureAccession } from '../../shared/figure-understanding'

/** 取数超时（毫秒）。库一次答不完就具名说超时，不无限等。 */
export const ACCESSION_LOOKUP_TIMEOUT_MS = 20_000

export const lookupAccessionOnMainFetch = async (
  accession: FigureAccession
): Promise<AccessionLookupOutcome> => {
  const id = accession.id
  try {
    const response = await fetch(accessionLookupUrl(accession), {
      // 带上 UA：真机读数里 AlphaFold 端点对本应用的取数回过 **403**（curl 同一路径是 200）—— 补上
      // 自称就 200 了。请求方如实表明自己是谁，也让对方能在出问题时找到我们。
      headers: { accept: 'application/json', 'user-agent': 'PureScience (accession lookup)' },
      signal: AbortSignal.timeout(ACCESSION_LOOKUP_TIMEOUT_MS)
    })
    // 库自己用 404 说「没有这一条」—— 这跟「没查」不是一回事，所以单独一种状态。
    if (response.status === 404) return { state: 'not-found', id }
    if (!response.ok) {
      return {
        state: 'unavailable',
        id,
        reason: `the entry service answered HTTP ${response.status}`
      }
    }
    return shapeAccessionLookup(accession, (await response.json()) as unknown)
  } catch (error) {
    return {
      state: 'unavailable',
      id,
      reason:
        error instanceof Error && error.name === 'TimeoutError'
          ? `no answer within ${ACCESSION_LOOKUP_TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : 'the lookup threw'
    }
  }
}
