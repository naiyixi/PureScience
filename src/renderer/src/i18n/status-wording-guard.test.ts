// Guard for the status-word families: the words these surfaces print for a state a reader is looking at
// come from the dictionaries, never from a literal in the component.
//
// Why a source scan rather than a render assertion: the defect shape is "the component spells the word
// itself", and several of these surfaces cannot be rendered cheaply (the sidebar needs stores, project and
// session fixtures; the network pill needs the monitor). Reading the file is what caught the shape last
// round, and it fails at the literal — the exact line a future edit would add back. Both sides are pinned:
// every key the surface should print must be referenced (so a renamed or deleted key is caught), and none
// of the English words those keys resolve to may appear as a string literal in that file.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { en } from './en'
import { zh } from './zh'

const SURFACES = [
  {
    file: '../pages/workspace/WorkspaceSidebar.tsx',
    keys: [
      'sessionStatus.label',
      'sessionStatus.idle',
      'sessionStatus.running',
      'sessionStatus.waitingPermission',
      'sessionStatus.waitingPlanApproval',
      'sessionStatus.error'
    ]
  },
  {
    file: '../components/NotificationBell.tsx',
    keys: [
      'notificationAction.needsResponse',
      'notificationAction.answered',
      'notificationAction.skipped',
      'notificationAction.needsApproval',
      'notificationAction.expired',
      'notificationAction.cancelled',
      'notificationAction.rejected',
      'notificationAction.resolved'
    ]
  },
  // The second carrier of the same defect: the words a control ANNOUNCES (aria-label) or explains itself
  // with (tooltip/label) were English literals in otherwise translated surfaces — invisible to a sighted
  // reader, read aloud in English by a screen reader, and shown in English inside a tooltip.
  {
    file: '../pages/workspace/WorkspaceToolCodeBlock.tsx',
    keys: ['a11y.copied', 'a11y.copyCode']
  },
  {
    file: '../pages/workspace/notebook-code.tsx',
    keys: ['a11y.copied', 'a11y.copyToClipboard']
  },
  {
    file: '../pages/workspace/ComposerContextUsage.tsx',
    keys: [
      'a11y.compactContext',
      'a11y.compactingContext',
      'a11y.contextUsed',
      'a11y.estimatedContext'
    ]
  },
  {
    file: '../pages/settings/SettingsPage.tsx',
    keys: ['a11y.maximize', 'a11y.restore']
  },
  {
    file: '../pages/workspace/LocalFileBrowser.tsx',
    keys: ['a11y.removeBookmark', 'a11y.pinFolder']
  },
  {
    file: '../pages/workspace/session-plan/SessionPlanSurfaces.tsx',
    keys: ['a11y.enterFullScreen', 'a11y.exitFullScreen']
  },
  {
    file: '../pages/workspace/WorkspaceMessageItem.tsx',
    keys: ['a11y.copied', 'a11y.copyMessage', 'a11y.modelProvider', 'a11y.modelProviderWithModel']
  },
  {
    file: '../components/streamdown/LinkSafetyModal.tsx',
    keys: ['a11y.openExternalLink']
  },
  {
    file: '../components/NetworkStatusIndicator.tsx',
    keys: [
      'network.offline',
      'network.unreachable',
      'network.noInternet',
      'network.internetUnreachable'
    ]
  },
  {
    file: '../components/environment-check-row.tsx',
    keys: ['common.ready', 'environmentStatus.review', 'environmentStatus.actionNeeded']
  },
  {
    file: '../pages/workspace/SpecialistSubmenu.tsx',
    keys: ['specialist.unavailable', 'ws.none']
  },
  {
    file: '../pages/workspace/previews/preview-errors.ts',
    keys: ['preview.missingTag']
  }
] as const

// Comments are prose, not render: a comment that names the word it replaced ("an English 'Action needed'
// beside a Chinese summary") is exactly the documentation we want, so the scan reads code only. The `//`
// stripper keeps `https://` intact by requiring the preceding character not to be a colon.
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const sources = SURFACES.map((surface) => {
  const text = readFileSync(new URL(surface.file, import.meta.url), 'utf8')
  return { ...surface, text: stripComments(text) }
})

// Every English word any of those keys resolves to, plus the words the pending row used to print. A word
// that is also legitimate copy keyed elsewhere is harmless here: this only reads the six files above.
const englishWords = [
  ...new Set(
    SURFACES.flatMap((surface) => surface.keys)
      .map((key) => en[key])
      .filter((value) => value.length > 0)
  )
]

describe('status wording comes from the dictionaries', () => {
  it('reads every surface (a scan that silently read nothing would prove nothing)', () => {
    expect(sources).toHaveLength(SURFACES.length)
    for (const source of sources) {
      expect(source.text.length).toBeGreaterThan(400)
    }
    expect(englishWords.length).toBeGreaterThanOrEqual(20)
  })

  it('resolves every pinned key in both dictionaries', () => {
    const missing = SURFACES.flatMap((surface) =>
      surface.keys
        .filter((key) => !(key in en) || !(key in zh))
        .map((key) => `${surface.file}: ${key}`)
    )
    expect(missing).toEqual([])
  })

  it('references each key it is supposed to print', () => {
    const unreferenced = sources.flatMap((source) =>
      source.keys
        .filter((key) => !source.text.includes(`'${key}'`))
        .map((key) => `${source.file}: ${key}`)
    )
    expect(unreferenced).toEqual([])
  })

  it('holds none of those English words as a string literal', () => {
    const offenders = sources.flatMap((source) =>
      englishWords
        .filter((word) => source.text.includes(`'${word}'`))
        .map((word) => `${source.file}: '${word}'`)
    )
    expect(offenders).toEqual([])
  })
})
