import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

// Real engine, real structure, real subprocess: the panel is only worth anything if the numbers on it
// came from ProteinMPNN. The two digests asserted here are computed in THIS process from the bytes on
// disk, so a panel that invented a fingerprint would fail instead of looking plausible.
const ENGINE_SRC = '/tmp/mpnn-src/ProteinMPNN'
const ENV_ROOT = '/tmp/ps-mamba/envs/invfold'
const PDB = '/tmp/1crn.pdb'
const NATIVE = 'TTCCPSIVARSNFNVCRLPGTPEAICATYTGCIIIPGATCPGDYAN'

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

test('designs sequences from a backbone and reports a recomputable fingerprint', async ({
  app
}) => {
  test.setTimeout(420_000)
  // The engine is provisioned per machine, never bundled. On a host without it this spec has nothing
  // to exercise — skipping by name is the honest outcome, not a green test that ran nothing.
  test.skip(
    !existsSync(ENGINE_SRC) || !existsSync(ENV_ROOT) || !existsSync(PDB),
    'ProteinMPNN source, environment or structure not provisioned on this host'
  )

  const page = await app.completeOnboarding()
  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
    }
    return (await bridge.api.storage.getInfo()).dataRoot
  })

  // Provision this run's data root by symlink: the app looks in its own layout, and copying 740 MB per
  // test would make the suite unusable.
  const engineSrc = join(dataRoot, 'runtime', 'engines', 'proteinmpnn')
  await mkdir(dirname(engineSrc), { recursive: true })
  await symlink(ENGINE_SRC, engineSrc, 'dir')
  await mkdir(join(dataRoot, 'runtime', 'envs'), { recursive: true })
  await symlink(ENV_ROOT, join(dataRoot, 'runtime', 'envs', 'invfold'), 'dir')

  const pdbPath = join(dataRoot, 'structures', '1crn.pdb')
  await mkdir(dirname(pdbPath), { recursive: true })
  await copyFile(PDB, pdbPath)

  const expected = {
    pdb: sha256(await readFile(pdbPath)),
    weights: sha256(await readFile(join(ENGINE_SRC, 'vanilla_model_weights', 'v_48_020.pt')))
  }

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Compute', exact: true }).click()

  const section = page.locator('[data-slot="inverse-folding"]')
  await expect(section).toBeVisible()
  await expect(section.getByRole('heading')).toHaveText('Inverse folding (backbone → sequence)')

  // Installed state: the input is there because all three paths resolved.
  const input = section.getByLabel('Path to a .pdb file')
  await expect(input).toBeVisible()
  await input.fill(pdbPath)
  await section.getByRole('button', { name: 'Design sequences' }).click()

  // The native chain comes from the structure the engine parsed — if it does not match crambin, the
  // engine never ran and the rest of the assertions would be meaningless.
  await expect(section.getByText(NATIVE)).toBeVisible({ timeout: 180_000 })
  await expect(section.getByText(/#1 · score/)).toBeVisible()

  // The fingerprint is recomputed here, not read from the panel's own claim.
  await expect(section.getByText(new RegExp(`pdb ${expected.pdb.slice(0, 16)}…`))).toBeVisible()
  await expect(
    section.getByText(new RegExp(`weights ${expected.weights.slice(0, 16)}…`))
  ).toBeVisible()
})
