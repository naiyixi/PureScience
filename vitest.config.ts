import { basename, dirname, resolve } from 'path'
import { defineConfig, configDefaults } from 'vitest/config'

import WindowsTestSequencer from './scripts/ci/windows-test-sequencer'

const testRoot = resolve('.')
const sharedInstallRoot = basename(dirname(testRoot)) === '.worktree' ? resolve('../..') : testRoot

// The Windows full-suite lane shards by MODULE (see scripts/ci/windows-test-sequencer.ts) instead of
// by file count: hosted Windows runners are disk-bound, so mixing SQLite-heavy and kernel suites in
// one shard wastes its wall clock. The flag is only set by that workflow; every other lane keeps the
// default sequencer.
const windowsFullTest = process.env.VITEST_WINDOWS_FULL_TEST === '1'

/** Project sequence: a group order, plus the module sequencer when the Windows lane asked for it. */
const windowAwareSequence = (groupOrder: number): Record<string, unknown> => ({
  groupOrder,
  ...(windowsFullTest ? { sequencer: WindowsTestSequencer } : {})
})

const VITEST_EXCLUDE_PATTERNS = [
  ...configDefaults.exclude,
  'e2e/**',
  '**/.claude/**',
  '**/.codex/**',
  '**/.pnpm-store/**',
  '**/tmp/**',
  '**/.worktrees/**',
  '**/.worktree/**'
]

// ---------------------------------------------------------------------------------------------
// Test partition (the four groups below are the single source of truth for BOTH this config and
// test/vitest-project-partition.test.ts, which fails when a file lands in no group, in two groups,
// or when a real-database test is left in the parallel pool).
//
// Why the split exists: the full suite is ~4,400 tests across parallel workers. Two kinds of suite
// behave badly under that swarm —
//   (a) whole-tree SCANNERS (they walk every source file, so they are CPU-bound and slow down
//       everyone while being starved themselves), and
//   (b) suites that spawn real child processes or open a real temp SQLite file (their waits are
//       wall-clock, so contention turns a 1s wait into a spurious timeout).
// Grouping those out fixes the flaky-timeout class structurally instead of by raising ceilings.
// ---------------------------------------------------------------------------------------------

/** Whole-tree/AST scanners. Serial, and ordered to run after the parallel pool. */
const ARCHITECTURE_TEST_GLOBS = ['src/**/*.architecture.test.ts']

/** Real kernels and child processes (also the lanes gated by RUN_KERNEL / RUN_SMOKE). */
const PROCESS_TEST_GLOBS = [
  'src/main/notebook/*-loop.integration.test.ts',
  'src/main/notebook/e2e.certification.test.ts',
  'src/main/notebook/full-stack.smoke.test.ts',
  'src/main/notebook/host-compute.integration.test.ts',
  'src/main/notebook/host-mcp.integration.test.ts',
  'src/main/notebook/windows-shell.integration.test.ts',
  'src/main/notebook/shell-process.test.ts',
  'src/main/notebook/micromamba-cache-acl.integration.test.ts',
  'src/main/notebook/runtime-service-logging.integration.test.ts',
  'src/main/agents/agents-repl.integration.test.ts',
  'src/main/agents/agents-repl.mutations.integration.test.ts',
  'src/main/agents/agents-repl.privileged.integration.test.ts',
  'src/main/agents/agents-repl.runtime-consumption.integration.test.ts',
  'src/main/compute/compute-jobs.integration.test.ts',
  'src/main/compute/concurrency-integration.test.ts',
  'src/main/compute/external-runner.test.ts',
  'src/main/process-tree.test.ts',
  'src/main/settings/process-tree.test.ts'
]

/**
 * Real temp SQLite (they call `createProjectDbClient` / `ensureProjectSchema`, i.e. a real
 * database file per file, not a mock). Kept out of the unbounded pool so file-system and lock
 * contention cannot starve them.
 */
const DATABASE_TEST_GLOBS = [
  'src/main/projects/prisma-client.test.ts',
  'src/main/projects/preview-repository.test.ts',
  'src/main/compute/prisma-client.test.ts',
  'src/main/compute/job-repository.test.ts',
  'src/main/project-files/repository.test.ts',
  'src/main/uploads/repository.test.ts',
  'src/main/permission-grants/registry.test.ts',
  'src/main/vision/vision-evidence-repository.test.ts',
  'src/main/references/citation-style-probe.test.ts',
  'src/main/skills/conversation-import.test.ts',
  'src/main/notebook/input-registry.test.ts',
  'src/main/reviewer/repository.test.ts',
  'src/main/reviewer/orchestrator.test.ts',
  'src/main/reviewer/orchestrator-prompt-prefix.test.ts',
  'src/main/reviewer/correction.test.ts',
  'src/main/reviewer/fix-loop.test.ts',
  'src/main/reviewer/lifecycle.test.ts',
  'src/main/reviewer/log-capture.test.ts',
  'src/main/artifacts/ipc.test.ts',
  'src/main/artifacts/provenance-repository.test.ts',
  'src/main/artifacts/provenance-message-snapshot.test.ts',
  'src/main/storage/provenance-migration-validation.test.ts',
  'src/main/storage/normalize-legacy-paths.test.ts',
  'src/main/acp/permission-broker-registry.test.ts',
  'src/main/acp/file-reference-resolver.test.ts',
  'src/main/acp/runtime.test.ts',
  'src/main/notifications/unread-task-repository.test.ts',
  'src/main/notifications/task-notification-runtime.test.ts',
  'src/main/notifications/notification-inbox-clear.test.ts',
  'src/main/session-persistence/deletion-integration.test.ts',
  'src/main/session-persistence/coordinator.test.ts',
  'src/main/session-persistence/artifact-finalization-recovery.integration.test.ts'
]

export const VITEST_TEST_GROUPS = {
  architecture: ARCHITECTURE_TEST_GLOBS,
  process: PROCESS_TEST_GLOBS,
  database: DATABASE_TEST_GLOBS
} as const

// Mirrors the renderer alias from electron.vite.config.ts so tests that mount real component
// trees (instead of mocking every aliased import) can resolve '@/...' without a build step.
export default defineConfig({
  server: {
    // Vitest may still canonicalize worker URLs through the shared install even when module
    // resolution preserves symlinks. Limit the additional allowance to this repository root.
    fs: { allow: [...new Set([testRoot, sharedInstallRoot])] }
  },
  resolve: {
    // Git worktrees reuse the repository-root dependency install through a local node_modules
    // symlink. Keep that logical path so Vite does not resolve PDF workers outside the test root and
    // reject them before the component suite can run. A normal checkout already has a local install.
    preserveSymlinks: true,
    alias: {
      '@': resolve('src/renderer/src'),
      '@renderer': resolve('src/renderer/src'),
      'e-virt-table/dist/index.es.js': resolve('test/fixtures/fake-e-virt-table.ts')
    }
  },
  test: {
    server: {
      deps: {
        inline: ['@file-viewer/renderer-spreadsheet']
      }
    },
    // Loads .env into process.env before tests run. Integration tests gated on RUN_COMPUTE_JOBS=1
    // read their target alias from COMPUTE_TEST_SSH_ALIAS. The file is gitignored; .env.example
    // documents the supported variables.
    setupFiles: ['./test/setup-dotenv.ts', './test/setup-jsdom-polyfills.ts'],
    // Keep vitest's defaults (node_modules, dist, .git, ...) and also ignore git worktrees — those hold
    // full source + node_modules copies that would otherwise be discovered and run as duplicate (and
    // often stale) suites during local runs. Playwright owns e2e/; Vitest must not execute those specs
    // in its Node workers. .worktree is the project-standard root; .claude remains excluded for
    // existing local checkouts.
    exclude: VITEST_EXCLUDE_PATTERNS,
    // Lift the 5s default: the full coverage run instruments 4400+ tests across parallel workers on a
    // shared CI runner, so a fast fully-mocked test can still be CPU-starved past 5s and time out
    // spuriously. 15s absorbs that contention without masking a genuine hang (real work is far slower).
    //
    // 15s turned out not to be enough either, measured on this machine (8 cores / 8 GB) at default
    // parallelism: the full suite goes red with 12 failing files / 77 failing tests while each of those
    // files passes in seconds when run without the swarm — 17 of the failures are real waits past 15s
    // (worst observed: an 80s wait for a test that finishes in about a second on its own) and the other
    // 58 are assertions cascading off them in the same files. A wait that is 80x its healthy duration is
    // contention, not a defect, so the ceiling is 60s here — still far below any real hang, and hook
    // timeouts get the same room (their default was 10s, which the same load also blew through).
    //
    // The serial groups below (architecture / process / database) remove the largest contention sources
    // outright, so this ceiling is a backstop rather than the only defence. See the group comments above
    // and test/vitest-project-partition.test.ts, which keeps the partition honest.
    testTimeout: 60000,
    hookTimeout: 60000,
    // Applies to the unit project (the heavy projects below repeat it alongside their groupOrder,
    // because a project-level `sequence` replaces this object rather than merging into it).
    ...(windowsFullTest ? { sequence: { sequencer: WindowsTestSequencer } } : {}),
    coverage: {
      provider: 'v8',
      // text for the CI log, lcov for upload/tooling, html for local inspection.
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      // Exclude non-logic files so coverage reflects testable code, not wiring/types.
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        'src/**/index.ts', // process entry / IPC composition wiring
        'src/preload/**', // declarative ipcRenderer bridge
        // The main-process IPC composition module: it wires each channel to the owner that holds the logic,
        // and the owners are tested where they live. It carries ~800 lines of registration, so a change of
        // a few lines in it used to put the whole file into the changed-file coverage set and drop the
        // selective gate below its thresholds whatever the diff was. Same category as the entry wiring
        // excluded above, and the same reasoning.
        'src/**/*types.ts',
        'src/renderer/src/main.tsx',
        'src/main/ipc.ts' // IPC composition wiring: 0/800 lines, same footing as index.ts / preload
      ],
      // Ratchet thresholds: fail CI when global coverage drops below these. Raise-only; slack is ~3
      // points below the measured value so the gate catches regressions without tripping on legitimate
      // variance.
      //
      // Measured 2026-09-27 (full suite, macOS): statements 84.98 / branches 75.37 / functions 83.07 /
      // lines 87.25. Cross-checked against the last successful main-branch CI run, which reported
      // 84.98 / 75.37 / 83.07 / 87.25 — identical to within 0.01pt, so a local measurement is a sound
      // basis for the number here.
      //
      // The previous values (66/62/57/64) dated from when lines measured 71 and were never raised, which
      // left roughly a 21-point window in which coverage could erode unnoticed.
      thresholds: {
        lines: 84,
        functions: 80,
        branches: 72,
        statements: 82,
        // Keep the now-covered update wiring from being masked by the global aggregate. Measured
        // 92.13 / 85.54 / 79.17 / 89.74 (lines / functions / branches / statements) on 2026-09-27, so
        // the old 85/75/70/80 was leaving the same kind of eroded window as the global thresholds.
        'src/main/update/**': {
          lines: 89,
          functions: 83,
          branches: 76,
          statements: 87
        },
        // CSV is a user-facing renderer with bounded-data and fallback behavior worth protecting.
        // Measured 100 / 100 / 84.61 / 100 on 2026-09-27 (the statement/line/function sides are fully
        // covered; the branch side carries the slack).
        'src/renderer/src/pages/workspace/previews/renderers/CsvPreview.tsx': {
          lines: 97,
          functions: 97,
          branches: 82,
          statements: 97
        }
      }
    },
    // Four groups over one shared worker pool. Coverage stays a ROOT option on purpose: it is a
    // non-project option in Vitest, and the gate must aggregate every group, not one of them.
    //
    // Group order is what Vitest uses to decide which projects share the pool: projects with the
    // SAME groupOrder run together, and groups run lowest to highest. Vitest also refuses to place
    // two projects with different `maxWorkers` in the same group, so the bounded heavy groups each
    // get their own order (1 = whole-tree scanners, 2 = real databases) and the unbounded pool keeps
    // group 0 to itself. That means the heavy groups run after the swarm, not inside it — which is
    // the point: neither a tree scanner nor a wall-clock wait should be competing with 12,000
    // fully-mocked tests for CPU.
    projects: [
      {
        // Everything that is safe to run in the unbounded parallel pool.
        //
        // `include` is deliberately NOT set: the unit group inherits Vitest's default discovery
        // (`**/*.{test,spec}.?(c|m)[jt]s?(x)`), which reaches test files outside src/ and test/ —
        // scripts/ci/** (the PR-gate classifiers and integrity checks), cli/**, packages/**,
        // build/packaging.test.ts, resources/**, and the root-level vitest.config.test.ts /
        // electron.vite.config.test.ts. Narrowing this to `src/**` + `test/**` silently drops about
        // forty suites while every remaining test still passes, so the group only ever subtracts
        // (via `exclude`) and never defines its own include. test/vitest-project-partition.test.ts
        // pins that breadth.
        extends: true,
        test: {
          name: 'unit',
          exclude: [
            ...VITEST_EXCLUDE_PATTERNS,
            ...ARCHITECTURE_TEST_GLOBS,
            ...PROCESS_TEST_GLOBS,
            ...DATABASE_TEST_GLOBS
          ]
        }
      },
      {
        // Whole-tree scanners: no isolation, one file at a time, after the parallel pool.
        extends: true,
        test: {
          name: 'architecture',
          include: ARCHITECTURE_TEST_GLOBS,
          exclude: VITEST_EXCLUDE_PATTERNS,
          isolate: false,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: windowAwareSequence(1)
        }
      },
      {
        // Real kernels and child processes: their waits are wall-clock, so they run one file at a
        // time with no other project competing for the machine.
        extends: true,
        test: {
          name: 'process',
          include: PROCESS_TEST_GLOBS,
          exclude: VITEST_EXCLUDE_PATTERNS,
          isolate: true,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: windowAwareSequence(2)
        }
      },
      {
        // Real temp SQLite per file: same treatment, so a lock or fs stall cannot starve a wait.
        extends: true,
        test: {
          name: 'database',
          include: DATABASE_TEST_GLOBS,
          exclude: VITEST_EXCLUDE_PATTERNS,
          isolate: true,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: windowAwareSequence(3)
        }
      }
    ]
  }
})

export { VITEST_EXCLUDE_PATTERNS }
