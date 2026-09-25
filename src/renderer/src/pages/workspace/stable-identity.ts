// Identity-preserving caches for values the transcript rebuilds on every streaming chunk.
//
// The scroller recomputes per-message values on each render (the session object is replaced per chunk),
// which hands the message item fresh arrays, objects and closures every time and defeats its memo. These
// helpers hand back the previous value whenever the new one carries the same content, so an unchanged
// message slot keeps an identical prop set — while a real change still produces a new value, because the
// comparison is on the inputs, not on the rendering.

export type IdentityCache<K, V> = Map<K, V>

const isSameValue = (left: unknown, right: unknown): boolean => Object.is(left, right)

// Element-wise identity: arrays rebuilt from the same instances are considered unchanged.
export const sameElements = (
  previous: readonly unknown[] | undefined,
  next: readonly unknown[]
): boolean =>
  previous !== undefined &&
  previous.length === next.length &&
  previous.every((entry, index) => isSameValue(entry, next[index]))

// Shallow own-field comparison for the small value objects built per slot (runtime identity, revision
// navigation).
const sameOwnFields = (previous: object, next: object): boolean => {
  const previousEntries = Object.entries(previous)
  const nextEntries = Object.entries(next)
  return (
    previousEntries.length === nextEntries.length &&
    previousEntries.every(([key, value]) => isSameValue(value, (next as Record<string, unknown>)[key]))
  )
}

export const stableArray = <K, T>(
  cache: IdentityCache<K, T[] | undefined>,
  key: K,
  next: T[]
): T[] => {
  const previous = cache.get(key)
  if (previous && previous.length === next.length && previous.every((e, i) => e === next[i])) {
    return previous
  }
  cache.set(key, next)
  return next
}

export const stableValue = <K, T>(cache: IdentityCache<K, T>, key: K, next: T): T => {
  const previous = cache.get(key)
  if (previous !== next && previous !== undefined) {
    const bothObjects = typeof previous === 'object' && typeof next === 'object'
    if (bothObjects && previous !== null && next !== null) {
      // Same kind of value object with equal fields: keep the instance the item already received. A
      // different constructor (a graph segment vs. a synthesized identity) always rebuilds.
      if ((previous as object).constructor === (next as object).constructor) {
        return sameOwnFields(previous as object, next as object) ? previous : next
      }
    }
  }
  cache.set(key, next)
  return next
}
