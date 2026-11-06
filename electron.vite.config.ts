import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    define: {
      // The Team ID has to be baked into the bundle: a packaged app launched from Finder inherits no
      // environment, so `process.env.PURESCIENCE_MAC_TEAM_ID` is empty there and the in-place mac update
      // would fail closed forever. A runtime env still wins (drills set it), the baked value is the fallback.
      __PURESCIENCE_MAC_TEAM_ID__: JSON.stringify(
        (process.env.PURESCIENCE_MAC_TEAM_ID ?? '').trim()
      )
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    // Regenerate lazy optimized chunks so a persisted Electron page cannot request stale hashes.
    optimizeDeps: { force: true },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    server: {
      // Don't watch git worktrees under .claude/worktrees — full source copies would trigger
      // needless rescans/HMR churn during dev.
      watch: { ignored: ['**/.claude/**'] }
    },
    plugins: [
      // Apply CJS interop for the spreadsheet Worker without injecting renderer presets.
      fileViewerRenderers({
        formats: ['xls', 'xlsx'],
        inject: false,
        chunkStrategy: 'none'
      }),
      react(),
      tailwindcss()
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'office-preview': resolve('src/renderer/office-preview.html')
        }
      }
    }
  }
})
