import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The installed CLI is reached through a symlink: npm writes node_modules/.bin/purescience -> ../purescience/cli.mjs
// (and a global install writes the same shape into the prefix). These tests run the real file through a link, because
// that is the only arrangement in which an entry-point check comparing raw paths looks fine and does nothing:
// `purescience --help` exited 0 without printing a word.

const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url))

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ps-cli-link-'))
})

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

const runThroughLink = async (
  args: ReadonlyArray<string>
): Promise<{ stdout: string; stderr: string; status: number | null }> => {
  const link = join(dir, 'purescience')
  // The shape npm creates on POSIX: a link in .bin pointing at the real entry.
  await symlink(cliPath, link)
  const result = spawnSync(process.execPath, [link, ...args], { encoding: 'utf8' })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

// Windows installs a .cmd shim instead of a symlink, so this arrangement does not exist there.
describe.skipIf(process.platform === 'win32')(
  'the CLI when it is reached through the bin symlink',
  () => {
    it('prints usage instead of exiting silently', async () => {
      const { stdout, status } = await runThroughLink(['--help'])
      expect(status).toBe(0)
      expect(stdout).toContain('Usage: purescience <command>')
    })

    it('answers which version it is', async () => {
      const manifest = JSON.parse(
        await readFile(new URL('./package.json', import.meta.url), 'utf8')
      ) as { version: string }
      const { stdout, status } = await runThroughLink(['--version'])
      expect(status).toBe(0)
      expect(stdout.trim()).toBe(manifest.version)
    })

    it('still refuses an unknown command over the link', async () => {
      // Refusals go to stderr; both streams count as "the CLI ran".
      const { stdout, stderr, status } = await runThroughLink(['definitely-not-a-command'])
      expect(status).not.toBe(0)
      expect(`${stdout}${stderr}`).toContain('Unknown command: definitely-not-a-command')
    })
  }
)
