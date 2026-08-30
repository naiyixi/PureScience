import { useLanguage, type TranslationKey } from '@/i18n'
import {
  ChevronDown,
  Download,
  FileUp,
  FolderInput,
  ListChecks,
  Pencil,
  Plus,
  Search,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { SkillSource, SkillView } from '../../../../shared/settings'
import { resolveEffectiveSpecialistSkills } from '../../../../shared/specialist'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useCatalogTagsStore } from '@/stores/catalog-tags-store'
import { CatalogFavoriteButton } from '@/components/catalog/CatalogFavoriteButton'
import { CatalogTagEditor } from '@/components/catalog/CatalogTagEditor'
import { CatalogFilterChips } from '@/components/catalog/CatalogFilterChips'
import { cn } from '@/lib/utils'
import { SkillDetailView } from './SkillDetailView'
import { SkillEditor, SkillEditLoader } from './SkillEditor'
import { SkillImportView } from './SkillImportView'
import { SkillUploadView } from './SkillUploadView'
import { AgentHomeImportView } from './AgentHomeImportView'
import { SettingsIconAction, SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'

// The skills panel sub-view, driven by the settings navigation history so each is a breadcrumb page.
export type SkillsView =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'create' }
  | { kind: 'edit'; id: string }
  | { kind: 'import' }
  | { kind: 'import-agent-home' }
  | { kind: 'upload' }

type SourceFilter = 'all' | SkillSource
type SkillScope = 'all' | 'main' | 'specialist'

const skillExportErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

const FILTER_LABELS: Record<SourceFilter, TranslationKey> = {
  all: 'settings.all',
  featured: 'settings.featured',
  imported: 'settings.imported',
  personal: 'settings.personal'
}

const SOURCE_GROUPS: ReadonlyArray<{
  source: SkillSource
  label: TranslationKey
  subtitle: TranslationKey
}> = [
  {
    source: 'featured',
    label: 'settings.featured',
    subtitle: 'settings.researchSkillsBundled'
  },
  {
    source: 'imported',
    label: 'settings.imported',
    subtitle: 'settings.skillsYouAddedFromGitHub'
  },
  {
    source: 'personal',
    label: 'settings.personal',
    subtitle: 'settings.yourCustomSkills'
  }
]

type SkillsPanelProps = {
  view: SkillsView
  onNavigate: (view: SkillsView) => void
  canImportInstalledSkills?: boolean
}

const SkillsPanel = ({
  view,
  onNavigate,
  canImportInstalledSkills = true
}: SkillsPanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const skills = useSettingsStore((state) => state.skills)
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const setSkillEnabled = useSettingsStore((state) => state.setSkillEnabled)
  const createSkill = useSettingsStore((state) => state.createSkill)
  const deleteSkill = useSettingsStore((state) => state.deleteSkill)
  const conversationSkillImportEnabled = useSettingsStore(
    (state) => state.conversationSkillImportEnabled
  )
  const setConversationSkillImportEnabled = useSettingsStore(
    (state) => state.setConversationSkillImportEnabled
  )
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Partial<Record<SkillSource, boolean>>>({})
  const [scope, setScope] = useState<SkillScope>('all')
  const [showFavorites, setShowFavorites] = useState(false)
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [batchError, setBatchError] = useState<string | undefined>()
  const [batchNotice, setBatchNotice] = useState<string | undefined>()
  const [deleteError, setDeleteError] = useState<string | undefined>()
  const [exportError, setExportError] = useState<string | undefined>()
  const [exportStatus, setExportStatus] = useState<{ id: string; message: string } | undefined>()
  const [exportingId, setExportingId] = useState<string | undefined>()
  const canExportSkills = typeof window.api?.settings?.exportSkill === 'function'

  const specialistItems = useSpecialistStore((state) => state.items)
  const specialistsLoaded = useSpecialistStore((state) => state.isLoaded)
  const loadSpecialists = useSpecialistStore((state) => state.load)
  const catalogEntries = useCatalogTagsStore((state) => state.entries)

  useEffect(() => {
    if (!specialistsLoaded) void loadSpecialists()
  }, [specialistsLoaded, loadSpecialists])

  // Reverse index skill id -> owning specialist names, so the panel can tell main-agent
  // skills apart from specialist-bound ones. Full-access specialists own every skill
  // except their exclusions; selected-mode specialists own their explicit list. Disabled
  // specialists do not claim ownership.
  const skillsCatalog = useMemo(
    () => skills.map((skill) => ({ id: skill.id, frameworkName: skill.name })),
    [skills]
  )
  const specialistNamesBySkillId = useMemo(() => {
    const index = new Map<string, string[]>()
    for (const item of specialistItems) {
      if (item.kind === 'reviewer' || !item.enabled) continue
      const resolved = resolveEffectiveSpecialistSkills(item, skillsCatalog)
      if (resolved.kind !== 'specialist') continue
      for (const skillId of resolved.skillIds) {
        index.set(skillId, [...(index.get(skillId) ?? []), item.name])
      }
    }
    return index
  }, [specialistItems, skillsCatalog])

  const exportSkill = async (id: string, name: string): Promise<void> => {
    if (!canExportSkills) return
    setExportError(undefined)
    setExportStatus(undefined)
    setExportingId(id)
    try {
      const result = await window.api.settings.exportSkill({ id })
      if (result.saved) {
        setExportStatus({ id, message: t('settings.exportedSkill').replace('{name}', name) })
      }
    } catch (error) {
      setExportError(skillExportErrorMessage(error) || t('settings.couldNotExportSkill'))
    } finally {
      setExportingId(undefined)
    }
  }

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  // `scoped` applies query/source/scope; `visible` additionally applies favorites + tags so
  // the chips row keeps offering tags that exist in the current scope even while a tag is
  // already active.
  const scoped = useMemo(() => {
    const term = query.trim().toLowerCase()
    return skills.filter((skill) => {
      if (filter !== 'all' && skill.source !== filter) return false
      if (scope === 'main' && (specialistNamesBySkillId.get(skill.id)?.length ?? 0) > 0) {
        return false
      }
      if (scope === 'specialist' && (specialistNamesBySkillId.get(skill.id)?.length ?? 0) === 0) {
        return false
      }
      if (!term) return true
      return (
        skill.name.toLowerCase().includes(term) || skill.description.toLowerCase().includes(term)
      )
    })
  }, [skills, filter, query, scope, specialistNamesBySkillId])

  const visible = useMemo(() => {
    return scoped.filter((skill) => {
      if (showFavorites && !catalogEntries[`skill:${skill.id}`]?.favorite) return false
      const tags = catalogEntries[`skill:${skill.id}`]?.tags ?? []
      return activeTags.every((tag) => tags.includes(tag))
    })
  }, [scoped, showFavorites, activeTags, catalogEntries])

  const toggleSelection = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const runBatch = async (apply: (skill: SkillView) => Promise<unknown>): Promise<void> => {
    setBatchError(undefined)
    setBatchNotice(undefined)
    const results = await Promise.allSettled(
      [...selectedIds].map((id) => {
        const skill = skills.find((candidate) => candidate.id === id)
        return skill ? apply(skill) : Promise.resolve()
      })
    )
    if (results.some((result) => result.status === 'rejected')) {
      setBatchError(t('settings.batchError'))
    }
    setSelectedIds(new Set())
  }

  const batchEnable = (): void => {
    void runBatch(async (skill) => {
      if (!skill.enabled) await setSkillEnabled(skill.id, true)
    })
  }

  const batchDisable = (): void => {
    void runBatch(async (skill) => {
      if (skill.enabled) await setSkillEnabled(skill.id, false)
    })
  }

  const batchDelete = (): void => {
    const skippedFeatured = [...selectedIds].filter(
      (id) => skills.find((skill) => skill.id === id)?.source === 'featured'
    ).length
    void runBatch(async (skill) => {
      if (skill.source === 'featured') return
      setDeleteError(undefined)
      await deleteSkill(skill.id)
    }).then(() => {
      if (skippedFeatured > 0) {
        setBatchNotice(t('settings.batchSkippedProtected').replace('{n}', String(skippedFeatured)))
      }
    })
  }

  if (view.kind === 'detail') {
    return <SkillDetailView skillId={view.id} />
  }
  if (view.kind === 'create') {
    return (
      <SkillEditor
        initial={{ name: '', description: '', body: '' }}
        onCancel={() => onNavigate({ kind: 'list' })}
        onSave={async (draft) => {
          await createSkill({
            name: draft.name,
            description: draft.description,
            body: draft.body,
            ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
            slug: draft.slug,
            references: draft.references
          })
          onNavigate({ kind: 'list' })
        }}
      />
    )
  }
  if (view.kind === 'edit') {
    return <SkillEditLoader skillId={view.id} onDone={() => onNavigate({ kind: 'list' })} />
  }
  if (view.kind === 'import') {
    return <SkillImportView onImported={() => undefined} />
  }
  if (view.kind === 'import-agent-home') {
    return canImportInstalledSkills ? (
      <AgentHomeImportView key={agentFrameworkId} onImported={() => undefined} />
    ) : (
      <div className="p-5 text-sm text-muted-foreground">
        {t('settings.installedSkillImportDesktopOnly')}
      </div>
    )
  }
  if (view.kind === 'upload') {
    return (
      <SkillUploadView
        onUploaded={() => onNavigate({ kind: 'list' })}
        onWriteInstead={() => onNavigate({ kind: 'create' })}
      />
    )
  }

  const groups = SOURCE_GROUPS.filter((group) => filter === 'all' || filter === group.source)

  return (
    <div className="p-5">
      <SettingsSection
        title={t('settings.conversationImports')}
        description={t('settings.conversationImportsDescription')}
        aria-label={t('settings.conversationImports')}
        className="mb-4 border-b border-border pb-4"
        contentClassName="mt-1"
      >
        <SettingsRow
          label={t('settings.skillPackages')}
          description={
            <span className="line-clamp-2">{t('settings.skillPackagesDescription')}</span>
          }
          className="min-h-0 py-1.5"
        >
          <div className="flex justify-end">
            <SettingsToggle
              enabled={conversationSkillImportEnabled}
              aria-label={t('settings.toggleConversationSkillImports')}
              onToggle={() =>
                void setConversationSkillImportEnabled(!conversationSkillImportEnabled)
              }
            />
          </div>
        </SettingsRow>
      </SettingsSection>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t('settings.scope')}
          className="inline-flex overflow-hidden rounded-lg border border-border-200"
        >
          {(
            [
              ['all', t('settings.all')],
              ['main', t('settings.mainAgent')],
              ['specialist', t('settings.specialistSkills')]
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
              className={cn(
                'px-2.5 py-1.5 text-xs transition-colors',
                scope === value
                  ? 'bg-bg-200 text-foreground'
                  : 'text-muted-foreground hover:bg-bg-100 hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Button
          variant={batchMode ? 'secondary' : 'outline'}
          size="sm"
          className="shrink-0"
          aria-pressed={batchMode}
          onClick={() => {
            setBatchMode((enabled) => !enabled)
            setSelectedIds(new Set())
            setBatchError(undefined)
            setBatchNotice(undefined)
          }}
        >
          <ListChecks className="size-4" aria-hidden="true" />
          {t('settings.batchMode')}
        </Button>
      </div>

      <div className="mb-3">
        <CatalogFilterChips
          resourceIds={scoped.map((skill) => `skill:${skill.id}`)}
          showFavorites={showFavorites}
          activeTags={activeTags}
          onToggleFavorites={() => setShowFavorites((value) => !value)}
          onToggleTag={(tag) =>
            setActiveTags((prev) =>
              prev.includes(tag) ? prev.filter((candidate) => candidate !== tag) : [...prev, tag]
            )
          }
          onClear={() => {
            setShowFavorites(false)
            setActiveTags([])
          }}
        />
      </div>

      {batchMode ? (
        <div
          data-testid="skills-batch-bar"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-200 bg-bg-100 px-3 py-2 text-xs"
        >
          <span className="text-foreground">
            {t('settings.selectedCount').replace('{n}', String(selectedIds.size))}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={visible.length === 0}
            onClick={() => setSelectedIds(new Set(visible.map((skill) => skill.id)))}
          >
            {t('settings.batchSelectAll')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selectedIds.size === 0}
            onClick={batchEnable}
          >
            {t('settings.batchEnable')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selectedIds.size === 0}
            onClick={batchDisable}
          >
            {t('settings.batchDisable')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={selectedIds.size === 0}
            onClick={batchDelete}
          >
            {t('settings.batchDelete')}
          </Button>
        </div>
      ) : null}

      {batchNotice ? (
        <p className="mb-3 rounded-lg border border-border-200 bg-bg-100 px-3 py-2 text-xs text-muted-foreground">
          {batchNotice}
        </p>
      ) : null}

      {batchError ? (
        <p role="alert" className="mb-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000">
          {batchError}
        </p>
      ) : null}

      <div className="mb-4 flex items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as SourceFilter)}>
          <SelectTrigger aria-label={t('settings.filterSkillsBySource')} className="w-36">
            <span>{t(FILTER_LABELS[filter])}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('settings.all')}</SelectItem>
            <SelectItem value="featured">{t('settings.featured')}</SelectItem>
            <SelectItem value="imported">{t('settings.imported')}</SelectItem>
            <SelectItem value="personal">{t('settings.personal')}</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={t('settings.searchSkills')}
            placeholder={t('settings.searchSkillsPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="shrink-0">
              <Plus data-icon="inline-start" aria-hidden="true" />
              {t('settings.addSkill')}
              <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'create' })}>
              <Pencil className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('settings.writeFromScratch')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.openSkillCreator')}
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'upload' })}>
              <FileUp className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('settings.uploadSkills')}</span>
                <span className="text-xs text-muted-foreground">{t('settings.pickSkillMd')}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'import' })}>
              <Download className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t('settings.importFromGitHub')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.addSkillFromRepo')}
                </span>
              </span>
            </DropdownMenuItem>
            {canImportInstalledSkills ? (
              <DropdownMenuItem
                className="gap-2.5"
                onSelect={() => onNavigate({ kind: 'import-agent-home' })}
              >
                <FolderInput className="size-4 shrink-0" aria-hidden="true" />
                <span className="flex flex-col">
                  <span>{t('settings.importInstalledSkills')}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('settings.scanGlobalSkills')}
                  </span>
                </span>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {deleteError ? (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
        >
          {deleteError}
        </p>
      ) : null}

      {exportError ? (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
        >
          {exportError}
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        {groups.map((group) => {
          const rows = visible.filter((skill) => skill.source === group.source)
          const expanded = !collapsed[group.source]

          return (
            <div key={group.source}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() =>
                  setCollapsed((prev) => ({ ...prev, [group.source]: !prev[group.source] }))
                }
                className="flex w-full flex-col items-start gap-0.5 text-left"
              >
                <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                  {t(group.label)}
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
                      expanded ? '' : '-rotate-90'
                    }`}
                    aria-hidden="true"
                  />
                </span>
                <span className="text-xs text-muted-foreground">{t(group.subtitle)}</span>
              </button>

              {expanded ? (
                rows.length > 0 ? (
                  <ul className="mt-2 flex flex-col divide-y divide-border">
                    {rows.map((skill) => {
                      const ownerNames = specialistNamesBySkillId.get(skill.id) ?? []
                      return (
                        <li
                          key={skill.id}
                          data-slot="settings-list-row"
                          className="flex min-h-14 items-center gap-2 py-2.5"
                        >
                          {batchMode ? (
                            <input
                              type="checkbox"
                              aria-label={t('settings.batchSelect').replace('{name}', skill.name)}
                              checked={selectedIds.has(skill.id)}
                              onChange={() => toggleSelection(skill.id)}
                              className="size-4 shrink-0 accent-[var(--accent)]"
                            />
                          ) : null}
                          <CatalogFavoriteButton
                            resourceId={`skill:${skill.id}`}
                            label={t('settings.favoriteSkill').replace('{name}', skill.name)}
                          />
                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() => onNavigate({ kind: 'detail', id: skill.id })}
                              className="block w-full text-left"
                            >
                              <span className="block truncate text-sm text-foreground">
                                {skill.name}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {skill.description}
                              </span>
                            </button>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              {ownerNames.length > 0 ? (
                                <span
                                  data-testid="skill-owner-badge"
                                  title={ownerNames.join(', ')}
                                  className="shrink-0 rounded-full border border-border-200 bg-bg-100 px-2 py-0.5 text-[11px] text-muted-foreground"
                                >
                                  {t('settings.ownerSpecialists')}
                                </span>
                              ) : (
                                <span
                                  data-testid="skill-owner-badge"
                                  className="shrink-0 rounded-full border border-border-200 bg-bg-100 px-2 py-0.5 text-[11px] text-muted-foreground"
                                >
                                  {t('settings.ownerMainAgent')}
                                </span>
                              )}
                              <CatalogTagEditor
                                resourceId={`skill:${skill.id}`}
                                addLabel={t('settings.addTag')}
                                tagsLabel={t('settings.tags')}
                                placeholder={t('settings.addTag')}
                              />
                            </div>
                          </div>
                          {exportStatus?.id === skill.id ? (
                            <span role="status" className="shrink-0 text-xs text-muted-foreground">
                              {exportStatus.message}
                            </span>
                          ) : null}
                          {skill.source !== 'featured' && canExportSkills ? (
                            <SettingsIconAction
                              label={t('settings.exportSkillAction').replace('{name}', skill.name)}
                              icon={Download}
                              disabled={exportingId !== undefined}
                              onClick={() => void exportSkill(skill.id, skill.name)}
                            />
                          ) : null}
                          {skill.source === 'personal' ? (
                            <SettingsIconAction
                              label={t('settings.editSkillAction').replace('{name}', skill.name)}
                              icon={Pencil}
                              onClick={() => onNavigate({ kind: 'edit', id: skill.id })}
                            />
                          ) : null}
                          {skill.source !== 'featured' ? (
                            <SettingsIconAction
                              label={t('settings.deleteSkillAction').replace('{name}', skill.name)}
                              icon={Trash2}
                              onClick={() => {
                                setDeleteError(undefined)
                                void deleteSkill(skill.id).catch((error) =>
                                  setDeleteError(
                                    error instanceof Error
                                      ? error.message
                                      : t('settings.thisSkillProtected')
                                  )
                                )
                              }}
                              danger
                            />
                          ) : null}
                          <SettingsToggle
                            enabled={skill.enabled}
                            aria-label={t('settings.toggleSkill').replace('{name}', skill.name)}
                            onToggle={() => void setSkillEnabled(skill.id, !skill.enabled)}
                          />
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="mt-2 py-2 text-xs text-muted-foreground">
                    {group.source === 'personal'
                      ? t('settings.createSkillHint')
                      : group.source === 'imported'
                        ? t('settings.noImportedSkillsYet')
                        : t('settings.noSkillsMatchSearch')}
                  </p>
                )
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export { SkillsPanel }
