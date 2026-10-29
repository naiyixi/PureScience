import { readFile } from 'node:fs/promises'

/**
 * The one reader a package path becomes bytes through.
 *
 * Both halves of the surface take a PATH (the exporter writes to one, the importer reads one), and the
 * desktop IPC adapter and the application-command adapter must not each invent their own byte reader —
 * a second one is how a package eventually gets read with different tolerances on the two surfaces.
 */
const readPackageFile = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(path))

export { readPackageFile }
