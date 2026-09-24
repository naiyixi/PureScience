// What a settings panel answers to when someone searches the panel list: its label, its stable id, and
// what it does (keywords) — the download source is called Network, so "mirror", "代理" and "npm" have to
// reach it too. Pure on purpose: the search surface is checkable without rendering the whole dialog.
export type SearchableSettingsPanel = {
  id: string
  label: string
  keywords?: readonly string[]
}

export const matchesSettingsQuery = (panel: SearchableSettingsPanel, query: string): boolean => {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return (
    panel.label.toLowerCase().includes(normalized) ||
    panel.id.toLowerCase().includes(normalized) ||
    (panel.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(normalized))
  )
}
