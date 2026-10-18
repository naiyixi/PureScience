import { copyFile, mkdir, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

// A real GROMACS run from the panel: real binary, real topology, real trajectory. What is asserted is
// what the engine actually produced — frame and atom counts that match the run, and the honesty line
// saying the bytes are not reproducible.
const ENV_ROOT = '/tmp/ps-mamba/envs/md'
const PDB = '/tmp/1crn.pdb'

test('runs a short trajectory and reports what the engine produced', async ({ app }) => {
  test.setTimeout(420_000)
  test.skip(
    !existsSync(ENV_ROOT) || !existsSync(PDB),
    'GROMACS environment or structure not provisioned on this host'
  )

  const page = await app.completeOnboarding()
  const dataRoot = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { storage: { getInfo: () => Promise<{ dataRoot: string }> } }
    }
    return (await bridge.api.storage.getInfo()).dataRoot
  })

  await mkdir(join(dataRoot, 'runtime', 'envs'), { recursive: true })
  await symlink(ENV_ROOT, join(dataRoot, 'runtime', 'envs', 'md'), 'dir')
  const pdbPath = join(dataRoot, 'structures', '1crn.pdb')
  await mkdir(dirname(pdbPath), { recursive: true })
  await copyFile(PDB, pdbPath)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Compute', exact: true }).click()

  const section = page.locator('[data-slot="molecular-dynamics"]')
  await expect(section).toBeVisible()
  await expect(section.getByRole('heading')).toHaveText('Molecular dynamics (vacuum, short run)')

  const input = section.getByLabel('Path to a .pdb file')
  await expect(input).toBeVisible()
  await input.fill(pdbPath)
  await section.getByRole('button', { name: 'Run trajectory' }).click()

  // 5000 steps at 2 fs with nstxout-compressed=500 is 11 frames; 46 residues with hydrogens is 642
  // atoms. Both numbers come from the run, so a panel that printed constants would fail here.
  await expect(section.getByText(/11 frames · 642 atoms/)).toBeVisible({ timeout: 300_000 })
  // One locator, matched against the result line itself: a bare /vacuum/ also hits the heading and the
  // intro paragraph, and a strict-mode violation there would hide whether the run really happened.
  await expect(section.getByText(/amber99sb-ildn · vacuum · 5000 steps · seed 37/)).toBeVisible()

  // The honesty line lives next to the digests on purpose — that is where someone would otherwise read
  // two equal-looking hashes as "two identical runs".
  await expect(section.getByText(/not byte-reproducible/i)).toBeVisible()
})
