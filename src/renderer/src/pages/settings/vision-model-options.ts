// Kept beside the picker so the rule is unit-testable without mounting Radix: a saved configuration must
// always be selectable, even when this render's candidate list does not produce it.
export type VisionModelOption = {
  provider: { id: string }
  model: string
}

const contains = (options: readonly VisionModelOption[], saved: VisionModelOption): boolean =>
  options.some((option) => option.provider.id === saved.provider.id && option.model === saved.model)

export const selectableVisionOptions = <T extends VisionModelOption>(
  saved: T | undefined,
  options: readonly T[]
): readonly T[] => {
  if (!saved || contains(options, saved)) return options
  return [saved, ...options]
}
