// The Home page shows distinct file-type chips per project (MD / DOCX / CSV …) and the Files read model is the
// only source for them. The rule lives here rather than in the page because main needs to derive the same
// kinds when it can answer for many projects in one round-trip: two copies of a derivation like this drift
// silently, and the chips are the only place the difference would show up.
export const PROJECT_FILE_KIND_LIMIT = 4

export const deriveProjectFileKinds = (
  items: ReadonlyArray<{ name: string; sortAtMs: number }>
): string[] => {
  const kinds: string[] = []
  for (const item of [...items].sort((left, right) => right.sortAtMs - left.sortAtMs)) {
    const dot = item.name.lastIndexOf('.')
    if (dot <= 0 || dot === item.name.length - 1) continue
    const ext = item.name.slice(dot + 1).toUpperCase()
    if (!/^[A-Z0-9]{1,5}$/.test(ext) || kinds.includes(ext)) continue
    kinds.push(ext)
    if (kinds.length >= PROJECT_FILE_KIND_LIMIT) break
  }
  return kinds
}
