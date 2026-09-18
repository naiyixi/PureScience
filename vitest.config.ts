import { basename, dirname, resolve } from 'path'
import { defineConfig, configDefaults } from 'vitest/config'

const testRoot = resolve('.')
const sharedInstallRoot = basename(dirname(testRoot)) === '.worktree' ? resolve('../..') : testRoot

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
    testTimeout: 60000,
    hookTimeout: 60000,
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
        'src/**/*types.ts',
        'src/renderer/src/main.tsx'
      ],
      // Baseline thresholds: fail CI when global coverage drops below these. Set ~5pts under the
      // current measured baseline (lines 71 / statements 70 / functions 68 / branches 62) so the gate
      // catches regressions while absorbing minor cross-environment variance. Raise over time.
      thresholds: {
        lines: 66,
        functions: 62,
        branches: 57,
        statements: 64,
        // Keep the now-covered update wiring from being masked by the global aggregate.
        'src/main/update/**': {
          lines: 85,
          functions: 75,
          branches: 70,
          statements: 80
        },
        // CSV is a user-facing renderer with bounded-data and fallback behavior worth protecting.
        'src/renderer/src/pages/workspace/previews/renderers/CsvPreview.tsx': {
          lines: 95,
          functions: 95,
          branches: 80,
          statements: 95
        }
      }
    }
  }
})

export { VITEST_EXCLUDE_PATTERNS }
