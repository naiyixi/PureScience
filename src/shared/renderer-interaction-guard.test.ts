import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Batch 5 (U26): the entry-layer audit's keyboard/focus work found the same defect twice — a surface
// that looks like a dialog (and therefore owns Escape, the focus trap and focus restore) while being a
// hand-written overlay that owns none of them. The shared shell exists now, so a bare modal declaration
// fails this guard.
const RENDERER_ROOT = join(__dirname, '..', 'renderer', 'src')

// The shared shell: the only place allowed to declare a modal dialog role by hand.
const SHARED_SHELL = /^components\/ui\/dialog/

// Non-modal popovers own their own dismissal and must not trap focus. Each entry is a decision.
const NON_MODAL_ALLOWLIST: Readonly<Record<string, string>> = {
  'pages/workspace/SessionInfoCard.tsx':
    'non-modal popover: owns a document Escape that yields to any open dialog, and must not trap focus',
  'components/NotificationBell.tsx':
    'anchored popover that becomes a sheet on mobile (aria-modal only there); owns Escape and returns focus to the bell',
  'components/streamdown/SourceLink.tsx':
    'hover card: dismisses on Escape, pointer leave and blur; trapping focus would strand the pointer'
}

const collectSource = (root: string, collected: string[] = []): string[] => {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      collectSource(path, collected)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    if (/\.test\.(ts|tsx)$/.test(entry)) continue
    collected.push(path)
  }

  return collected
}

const normalize = (text: string): string => text.replace(/[\s?]/g, '')

// `relative` answers with backslashes on Windows, where the shell/allowlist patterns use slashes.
const toPosix = (path: string): string => path.replaceAll('\\', '/')

const rendererFiles = collectSource(RENDERER_ROOT).map((path) => ({
  path: toPosix(relative(RENDERER_ROOT, path)),
  source: normalize(readFileSync(path, 'utf8'))
}))

// A declaration, not a detection: `[role="dialog"]` inside a selector string (how a popover yields to
// an open dialog) is not a surface claiming to be a dialog.
const declaresDialogRole = (source: string): boolean => {
  for (let index = source.indexOf('role='); index !== -1; index = source.indexOf('role=', index + 1)) {
    const previous = source[index - 1] ?? ''
    if (previous === '[' || previous === "'" || previous === '"') continue
    if (/^role=["']?\[?"?'?dialog/.test(source.slice(index))) return true
  }

  return false
}

const dialogDeclarations = rendererFiles.filter((file) => declaresDialogRole(file.source)).map((file) => file.path)

// The audit's mechanical feature for a missing empty state: a group rendered only when the list is
// non-empty, with nothing anywhere in the file that names the empty case.
const collectionGatesLackingEmptyState = rendererFiles
  .filter((file) => /\.tsx$/.test(file.path))
  .filter((file) => /length>0(\?|&&)/.test(file.source))
  .filter((file) => !/empty/i.test(file.source))
  .map((file) => file.path)

describe('renderer interaction guard', () => {
  it('requires the shared dialog shell for every modal surface', () => {
    const offenders = dialogDeclarations
      .filter((path) => !SHARED_SHELL.test(path))
      .filter((path) => !(path in NON_MODAL_ALLOWLIST))

    expect(
      offenders,
      'use the shared dialog shell (ESC + focus trap + focus restore), or record why this surface is a non-modal popover'
    ).toEqual([])
  })

  it('keeps the non-modal allowlist honest: each entry really declares a dialog role', () => {
    const stale = Object.keys(NON_MODAL_ALLOWLIST).filter(
      (path) => !dialogDeclarations.includes(path)
    )

    expect(stale, 'these allowlisted files no longer declare a dialog role').toEqual([])
  })

  it('matches Windows separators, so the platform cannot silently disable the guard', () => {
    // The failure this documents: on a Windows runner `relative` returned `components\\NotificationBell.tsx`,
    // the allowlist keys (written with slashes) stopped matching, and both assertions above failed there
    // while passing locally.
    expect(toPosix('components\\NotificationBell.tsx')).toBe('components/NotificationBell.tsx')
    expect(NON_MODAL_ALLOWLIST['components/NotificationBell.tsx']).toBeDefined()
    expect(SHARED_SHELL.test(toPosix('components\\ui\\dialog.tsx'))).toBe(true)
  })

  it('reports collection surfaces that gate on a non-empty list without naming the empty state', () => {
    // A warning by design: whether a list needs an empty state is a judgement call, so this prints the
    // candidates (with a count) instead of failing the build.
    if (collectionGatesLackingEmptyState.length > 0) {
      console.warn(
        `[entry-layer] ${collectionGatesLackingEmptyState.length} file(s) gate a collection on length > 0 with no empty-state token: ${collectionGatesLackingEmptyState.join(', ')}`
      )
    }

    expect(Array.isArray(collectionGatesLackingEmptyState)).toBe(true)
  })
})
