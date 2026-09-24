import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ENTRY_LAYER_ARCHIVED_SURFACES } from './entry-layer-archived-surfaces'
import { RENDERER_CONTRACT_CATALOG } from './renderer-contract-catalog'

// Batch 5 (U25): a surface the desktop app installs but the window never calls is exactly the defect
// class the entry-layer audit spent four batches closing. Nothing in the type system or the existing
// suites notices a new one, so this guard does: either the renderer calls it, or a reviewed entry in
// `entry-layer-archived-surfaces.ts` says why it stays agent-only.
const RENDERER_ROOT = join(__dirname, '..', 'renderer', 'src')
const DESKTOP_INSTALLATIONS = new Set(['preload', 'browser-native'])

const collectSource = (root: string, collected: string[] = []): string[] => {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      collectSource(path, collected)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    // Tests are not consumers, and the string dictionaries cannot call anything. The i18n module
    // itself can (it persists the UI language), so only the per-language dictionaries are skipped.
    if (/\.test\.(ts|tsx)$/.test(entry)) continue
    if (/^i18n\/(en|zh|zh-Hant|ja|ko|de|es|fr|ru)\.ts$/.test(relative(RENDERER_ROOT, path))) continue
    collected.push(path)
  }

  return collected
}

// Optional chaining and line breaks are cosmetic, and the window reaches a capability through several
// spellings (`window.api.handoff.list`, `const h = window.api?.handoff; h.list(...)`). So a surface
// counts as exposed when one file mentions both its capability and its member — deliberately tolerant,
// because the value of this guard is catching a *newly declared* surface, whose member name otherwise
// appears nowhere in the window at all.
const normalize = (text: string): string => text.replace(/[\s?]/g, '')

const rendererFiles = collectSource(RENDERER_ROOT).map((path) => ({
  path: relative(RENDERER_ROOT, path),
  source: normalize(readFileSync(path, 'utf8'))
}))

const isExposed = (capability: string, member: string): boolean => {
  const capabilityToken = normalize(capability)
  const memberToken = normalize(member)

  return rendererFiles.some(
    (file) => file.source.includes(capabilityToken) && file.source.includes(memberToken)
  )
}

const desktopSurfaces = RENDERER_CONTRACT_CATALOG.filter((contract) =>
  DESKTOP_INSTALLATIONS.has(contract.surfaceInstallation.electron)
)

const archivedPaths = new Set(ENTRY_LAYER_ARCHIVED_SURFACES.map((entry) => entry.publicPath))

describe('renderer contract entry coverage', () => {
  it('exposes every desktop surface the contract catalog declares', () => {
    const unexposed = desktopSurfaces
      .filter((contract) => {
        const [capability, member] = contract.publicPath.split('.')
        return !isExposed(capability, member ?? capability)
      })
      .filter((contract) => !archivedPaths.has(contract.publicPath))
      .map((contract) => `${contract.publicPath} (${contract.channel ?? 'no channel'})`)

    expect(
      unexposed,
      'wire these surfaces into the window, or record why they stay agent-only in entry-layer-archived-surfaces.ts'
    ).toEqual([])
  })

  it('keeps the archive register honest: an archived surface is really unexposed', () => {
    // Otherwise a surface that gets wired later stays "archived" forever and the register drifts away
    // from the code it describes.
    const wired = ENTRY_LAYER_ARCHIVED_SURFACES.filter((entry) => {
      const [capability, member] = entry.publicPath.split('.')
      return isExposed(capability, member ?? capability)
    }).map((entry) => entry.publicPath)

    expect(wired, 'these surfaces are wired again and must leave the archive register').toEqual([])
  })

  it('keeps the archive register honest: every entry still exists in the catalog', () => {
    const known = new Set(RENDERER_CONTRACT_CATALOG.map((contract) => contract.publicPath))
    const stale = ENTRY_LAYER_ARCHIVED_SURFACES.filter((entry) => !known.has(entry.publicPath)).map(
      (entry) => entry.publicPath
    )

    expect(stale, 'these registered paths no longer exist in the contract catalog').toEqual([])
  })

  it('requires a reason and evidence for each archived surface', () => {
    const thin = ENTRY_LAYER_ARCHIVED_SURFACES.filter(
      (entry) => entry.reason.trim().length < 20 || entry.evidence.trim().length < 8
    ).map((entry) => entry.publicPath)

    expect(thin, 'an archived surface needs a decision and its evidence').toEqual([])
  })

  it('reports surfaces the desktop app does not install (context, never a failure)', () => {
    const notInstalled = RENDERER_CONTRACT_CATALOG.filter(
      (contract) => !DESKTOP_INSTALLATIONS.has(contract.surfaceInstallation.electron)
    )
    // Printed so the number is visible in CI logs; these are web-only/rejecting surfaces by design.
    console.log(
      `[entry-layer] desktop surfaces: ${desktopSurfaces.length}, non-desktop: ${notInstalled.length}, archived: ${ENTRY_LAYER_ARCHIVED_SURFACES.length}`
    )
    expect(desktopSurfaces.length).toBeGreaterThan(0)
  })
})
