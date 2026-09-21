import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The reference-library half of the session package reads the CURRENT attachment off the reference row.
// Its first version asked the history table (`ReferenceAttachmentVersion`) instead, which only ever
// records superseded files — so every exported package carried zero papers while the unit tests stayed
// green, because the port's fixture handed the attachment over directly. Only a real export found it.
//
// These assertions read the source text on purpose: the drift is a second source of truth for the same
// question ("which PDF is attached right now?"), and only the files' own contents can prove it is gone.
const sourceOf = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

describe('session package reference wiring', () => {
  it('reads the current attachment from the reference row, never from the superseded-version history', () => {
    const ipc = sourceOf('../ipc.ts')

    expect(ipc).toContain('createSessionPackageReferenceLibrary(')
    // The history table holds files that were replaced. Asking it for the current one returns nothing.
    expect(ipc).not.toMatch(/listAttachmentVersions/u)
  })

  it('keeps a single place that maps a reference to its attached file', () => {
    const referenceFiles = sourceOf('./reference-files.ts')

    expect(referenceFiles).toMatch(/export const currentReferencePdfId/u)
    expect(referenceFiles).toMatch(/currentReferencePdfId\(reference\)/u)
    // The row field itself, not a history lookup.
    expect(referenceFiles).toContain('reference.pdfManagedFileId')
  })
})
