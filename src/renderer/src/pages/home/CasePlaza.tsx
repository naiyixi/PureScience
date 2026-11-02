import { useMemo } from 'react'

import { useLanguage } from '@/i18n'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'

// The case plaza: the demos on the home page are the work this machine actually did, not screenshots and not
// a static sample set. Each card is a project the user created, with the two numbers the app genuinely holds —
// how many sessions it has and when it last moved — and one action: open it.
//
// Three rules this component keeps:
//   * a project with no session is not a demo: it has nothing to show, so it is left out (and when nothing
//     qualifies, the panel says so instead of rendering an empty grid that looks broken);
//   * example projects are excluded: they ship with the app, so counting them as "your cases" would be a lie;
//   * no reading is invented — a missing timestamp is left out of the sentence, never printed as 0 or as now.
const MAX_CASES = 6

const formatWhen = (timestamp: number | undefined, locale: string): string | undefined => {
  if (!timestamp || !Number.isFinite(timestamp)) return undefined
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
      new Date(timestamp)
    )
  } catch {
    return undefined
  }
}

export const CasePlaza = (): React.JSX.Element => {
  const { t, lang } = useLanguage()
  const projects = useProjectStore((state) => state.projects)
  const sessions = useSessionStore((state) => state.sessions)
  const openProject = useNavigationStore((state) => state.openProject)

  const cases = useMemo(() => {
    const byProject = new Map<string, { count: number; last?: number }>()
    for (const session of sessions as Array<{
      projectId: string
      createdAt?: number
      updatedAt?: number
    }>) {
      const entry = byProject.get(session.projectId) ?? { count: 0, last: undefined }
      entry.count += 1
      const stamp = session.updatedAt ?? session.createdAt
      if (stamp && (!entry.last || stamp > entry.last)) entry.last = stamp
      byProject.set(session.projectId, entry)
    }

    return projects
      .filter((project) => project.archivedAt === undefined && !project.isExample)
      .flatMap((project) => {
        const entry = byProject.get(project.id)
        if (!entry || entry.count === 0) return []
        const last = Math.max(entry.last ?? 0, project.updatedAt ?? 0) || undefined
        return [{ project, sessions: entry.count, last }]
      })
      .sort((left, right) => (right.last ?? 0) - (left.last ?? 0))
      .slice(0, MAX_CASES)
  }, [projects, sessions])

  return (
    <section data-slot="case-plaza" aria-label={t('home.casePlaza.title')} className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-text-000">{t('home.casePlaza.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('home.casePlaza.subtitle')}</p>
      </div>

      {cases.length === 0 ? (
        <p data-slot="case-plaza-empty" className="mt-2 text-xs text-muted-foreground">
          {t('home.casePlaza.empty')}
        </p>
      ) : (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cases.map(({ project, last }) => {
            const when = formatWhen(last, lang)
            return (
              <li key={project.id}>
                <button
                  type="button"
                  data-slot="case-plaza-card"
                  onClick={() => openProject(project.id, 'user')}
                  className="flex h-full w-full flex-col gap-1.5 rounded-2xl border border-border-200/70 bg-bg-000 p-4 text-left shadow-card transition-colors duration-150 ease-out hover:border-text-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span className="truncate text-sm font-medium text-text-000">{project.name}</span>
                  {project.description ? (
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {project.description}
                    </span>
                  ) : null}
                  {/* No session COUNT here on purpose: the home page's own rule is that a partially loaded
                      catalogue must not present a count as authoritative ("Session count unavailable"), and this
                      panel reads the same store. A timestamp is always real, so that is what it shows. */}
                  <span className="mt-auto text-[11px] text-muted-foreground">
                    {when
                      ? t('home.casePlaza.lastActive').replace('{when}', when)
                      : t('home.casePlaza.ranHere')}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
