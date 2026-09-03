// Pure comparator for the specialist marketplace listing sort control. Kept import-free so it is
// unit-testable without pulling the component (and its stores) into the test environment.
//
// The marketplace snapshot carries no release timestamps (sources are resolved by git ref, not by
// release-date metadata), so a truthful "recently updated" sort is impossible today. The closest
// honest proxy is semantic-version order (newest release first within a source); name order is the
// other stable option.

export type MarketplaceSortKind = 'version' | 'name'

export type SortableListing = {
  displayName: string
  version: string
}

// Compares two semver-ish version strings segment by segment: numeric segments compare numerically,
// non-numeric segments compare case-insensitively, shorter segment lists sort first when equal
// prefix (1.2 < 1.2.0 is not asserted — equal prefixes fall through to the next segment count).
// Returns negative when `left` is newer than `right` (descending intent).
const compareNewest = (left: SortableListing, right: SortableListing): number => {
  const leftParts = left.version.split('.')
  const rightParts = right.version.split('.')
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    if (leftPart === undefined) return 1
    if (rightPart === undefined) return -1
    const leftNumber = Number(leftPart)
    const rightNumber = Number(rightPart)
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) return rightNumber - leftNumber
      continue
    }
    const compared = leftPart.localeCompare(rightPart, undefined, { numeric: true })
    if (compared !== 0) return -compared
  }
  return 0
}

const compareByName = (left: SortableListing, right: SortableListing): number =>
  left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' })

// Stable sort of marketplace listings by the requested kind. `version` = newest-first; `name` =
// case-insensitive ascending. Equal items keep their original (snapshot) order via the index.
export const sortMarketplaceListings = <T extends SortableListing>(
  listings: readonly T[],
  kind: MarketplaceSortKind
): T[] =>
  [...listings]
    .map((listing, index) => ({ listing, index }))
    .sort((left, right) => {
      const compared =
        kind === 'version'
          ? compareNewest(left.listing, right.listing)
          : compareByName(left.listing, right.listing)
      return compared !== 0 ? compared : left.index - right.index
    })
    .map(({ listing }) => listing)
