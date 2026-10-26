// The lazy-channel change moved a mirror speed probe off startup. Unit tests prove the resolver is not
// called at construction and that its value reaches micromamba's argv; neither proves that a real
// provision still works against a real mirror. This does, and it is the only test that downloads.
//
//   PURESCIENCE_REAL_PROVISION=1 npx vitest run src/main/notebook/real-provision.integration.test.ts
//
// Two parts, because they prove different things:
//   1. a deliberately bogus channel must make micromamba fail with THAT name in the message — proof the
//      resolved value really flows into the child process, not just into a log line;
//   2. the channel the real probe picks (no configured mirror, which is the case that used to block
//      startup) must produce an environment with a working interpreter.
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { effectiveMirrorAsync } from './mirror-probe'
import { createProductionProvisioner } from './provisioner'
import { envPrefix } from './runtime-paths'

const CHANNEL_TIMEOUT_MS = 20 * 60 * 1000

describe.runIf(process.env.PURESCIENCE_REAL_PROVISION === '1')(
  'real provision with a lazily resolved channel',
  () => {
    it(
      'sends the resolved channel to micromamba, and the real probed channel builds a usable env',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'ps-real-provision-'))
        const resolved: string[] = []

        try {
          // Part 1: a bogus channel must surface in micromamba's own failure text.
          const bogus = `file:///nonexistent-channel-${Date.now()}`
          const bogusProvisioner = createProductionProvisioner({
            root,
            channel: async () => {
              resolved.push(bogus)
              return bogus
            },
            micromamba: { home: homedir() }
          })

          // Nothing may be resolved before the create is asked for: that is the whole point of the change.
          expect(resolved).toHaveLength(0)
          const failure = await bogusProvisioner
            .createNamedEnvironment('lazy-channel-bogus', 'python', [])
            .then(
              () => undefined,
              (error: unknown) => error as Error & { data?: { stderrTail?: string } }
            )
          expect(resolved).toHaveLength(1)
          expect(failure).toBeDefined()
          const detail = JSON.stringify({
            message: failure?.message,
            stderrTail: failure?.data?.stderrTail
          })
          expect(detail).toContain('nonexistent-channel')

          // Part 2: the channel the real probe picks, i.e. the path a user with no configured mirror takes.
          const probed: string[] = []
          const provisioner = createProductionProvisioner({
            root,
            channel: async () => {
              const mirror = await effectiveMirrorAsync(undefined, 'zh-CN')
              const channel = mirror.condaChannel ?? 'conda-forge'
              probed.push(channel)
              return channel
            },
            micromamba: { home: homedir() }
          })

          expect(probed).toHaveLength(0)
          await provisioner.createNamedEnvironment('lazy-channel-proof', 'python', [])
          expect(probed).toHaveLength(1)

          const prefix = envPrefix(root, 'lazy-channel-proof')
          const interpreter = join(prefix, 'bin', 'python')
          expect((await stat(interpreter)).isFile()).toBe(true)

          // Written, not logged: this repo's vitest config swallows `console.log`, and the channel the probe
          // picked is the actual reading this test exists to produce.
          await writeFile(
            join(process.cwd(), 'docs/bench-runs/2026-10-26-real-provision.txt'),
            [
              `resolved channel (part 1, bogus)=${resolved[0]}`,
              `probed channel (part 2, real)=${probed[0]}`,
              `interpreter=${interpreter}`,
              `prefix bytes=${(await stat(prefix)).size}`,
              ''
            ].join('\n'),
            'utf8'
          )
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
      CHANNEL_TIMEOUT_MS
    )
  }
)
