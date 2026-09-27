import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

/**
 * Module-aware sharding for the Windows full-suite lane.
 *
 * The Windows runner is disk-bound: hosted Windows runners serialize file I/O badly, so a shard that
 * mixes SQLite-heavy suites with kernel or packaging suites spends most of its wall clock waiting.
 * Vitest's default sharding splits by file count, which scatters one module across every shard and
 * puts unrelated heavy suites in the same one.
 *
 * So the lane uses EIGHT shards (index = group + 1) whose membership is decided by module prefix:
 * one module family per shard, and the last shard owns everything not named here — including new
 * directories, so this routing can never limit discovery. Group sizes were measured against the real
 * test tree (see windows-test-sequencer.test.ts, which re-measures them on every run and fails when
 * they drift apart).
 *
 * Order matters: the first matching group wins, so more specific prefixes are listed before the
 * prefixes that contain them.
 */
export const WINDOWS_TEST_SHARD_COUNT = 8

export const WINDOWS_TEST_MODULE_GROUPS = [
  // 1: Renderer workspace pages — the largest jsdom cluster.
  ['src/renderer/src/pages/workspace/'],
  // 2: The rest of the renderer (other pages, stores, components, renderer libraries).
  [
    'src/renderer/src/pages/',
    'src/renderer/src/stores/',
    'src/renderer/src/components/',
    'src/renderer/src/lib/'
  ],
  // 3: Notebook runtime plus the application-composition specs that live at src/main's root.
  ['src/main/notebook/', 'src/main/tray', 'src/main/window', 'src/main/lifecycle', 'src/main/app-'],
  // 4: Settings, storage and session persistence.
  [
    'src/main/settings/',
    'src/main/storage/',
    'src/main/session-persistence/',
    'src/main/session-package/',
    'src/main/local-fs/',
    'src/main/archive/',
    'src/main/projects/',
    'src/main/project-files/',
    'src/main/uploads/'
  ],
  // 5: Agent runtime and orchestration.
  [
    'src/main/acp/',
    'src/main/agent-framework/',
    'src/main/agents/',
    'src/main/session-plan/',
    'src/main/background-delivery/',
    'src/main/engines/',
    'src/main/cli-install/',
    'src/main/tasks/'
  ],
  // 6: Scientific connectors and the services around research content.
  [
    'src/main/connectors/',
    'src/main/references/',
    'src/main/search/',
    'src/main/notifications/',
    'src/main/diagnostics/',
    'src/main/web-service/',
    'src/main/update/',
    'src/main/net/',
    'src/main/remote-access/',
    'src/main/office-preview/',
    'src/main/vision/'
  ],
  // 7: Artifacts, review and capability packages.
  [
    'src/main/artifacts/',
    'src/main/reviewer/',
    'src/main/skills/',
    'src/main/specialist/',
    'src/main/permission-grants/',
    'src/main/compute/'
  ]
  // 8 (the shard after this list, and the fallback below): shared contracts and tooling —
  // src/shared, scripts, packages, cli, build, resources, plus test/ and anything new.
] as const

/** Shard index (1-based) for a repository-relative test path, on either path separator. */
export function windowsTestShard(path: string): number {
  const normalized = path.replaceAll('\\', '/')
  const group = WINDOWS_TEST_MODULE_GROUPS.findIndex((prefixes) =>
    prefixes.some((prefix) => normalized.startsWith(prefix))
  )
  return group < 0 ? WINDOWS_TEST_SHARD_COUNT : group + 1
}

export default class WindowsTestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard
    if (!shard) return files
    // Fail closed: a different shard count would silently drop whole module groups, so refuse to run
    // rather than cover a subset that looks green.
    if (shard.count !== WINDOWS_TEST_SHARD_COUNT) {
      throw new Error(
        `Module-aware Windows sharding requires exactly ${WINDOWS_TEST_SHARD_COUNT} shards (got ${shard.count}).`
      )
    }
    return files.filter(
      (file) => windowsTestShard(relative(this.ctx.config.root, file.moduleId)) === shard.index
    )
  }
}
