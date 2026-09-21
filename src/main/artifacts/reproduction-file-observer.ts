import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  REPRODUCIBILITY_MAX_COMPARE_BYTES,
  type ReproducedFileObservation
} from '../../shared/reproducibility'
import { resolveAllowedImportFilePath } from './storage-access'

// Turns a caller-supplied reproduction path into observed bytes.
//
// Two rules matter here. A path outside the turn's authorized roots is never read — it becomes a
// `not-allowed` observation, which the shared engine reports as `not-compared` rather than a pass.
// And a file past the comparison bound is never hashed: its size is reported and the engine withholds
// the verdict, so a bound cannot be mistaken for an equality.

const hashFile = async (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })

const classifyResolutionError = (
  error: unknown
): ReproducedFileObservation & { state: 'unreadable' } => {
  const message = error instanceof Error ? error.message : String(error)
  const reason = message.includes('outside allowed artifact import roots')
    ? 'not-allowed'
    : message.includes('is not a file')
      ? 'not-a-file'
      : message.includes('does not exist')
        ? 'not-found'
        : 'read-failed'

  return { state: 'unreadable', path: '', filename: '', reason }
}

export const createReproductionFileObserver = ({
  allowedImportRoots,
  relativeBaseDirs = []
}: {
  allowedImportRoots: string[]
  relativeBaseDirs?: string[]
}): ((path: string) => Promise<ReproducedFileObservation>) => {
  return async (path) => {
    const filename = basename(path)
    let report: Awaited<ReturnType<typeof resolveAllowedImportFilePath>>
    try {
      report = await resolveAllowedImportFilePath(path, allowedImportRoots, relativeBaseDirs)
    } catch (error) {
      return { ...classifyResolutionError(error), path, filename }
    }

    const resolved = report.path
    try {
      const info = await stat(resolved)
      if (info.size > REPRODUCIBILITY_MAX_COMPARE_BYTES) {
        return { state: 'observed', path, filename, sizeBytes: info.size, sha256: '' }
      }

      return {
        state: 'observed',
        path,
        filename,
        sizeBytes: info.size,
        sha256: await hashFile(resolved)
      }
    } catch {
      return { state: 'unreadable', path, filename, reason: 'read-failed' }
    }
  }
}
