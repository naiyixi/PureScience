import { readFileSync } from 'node:fs'

import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

// Third-party skills we redistribute verbatim are not our source: their scripts came with the author's license,
// and running our prettier/TS rules over them would rewrite files we promised to ship as written. Derived from
// the manifest (never a hand list) so removing a collection removes its exemption too.
const thirdPartySkillIgnores = (() => {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('./resources/skills/manifest.json', import.meta.url), 'utf8')
    )
    return manifest.skills
      .filter((skill) => skill.thirdParty !== undefined)
      .map((skill) => `resources/skills/${skill.id}/**`)
  } catch {
    return []
  }
})()

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      // Packaged e2e build output (electron-builder --dir into dist-e2e-*); bundled JS, not source.
      '**/dist-e2e-*',
      // Runtime kernel loop scripts shipped as raw resources (CommonJS, not part of the TS source tree).
      'resources/notebook/*.js',
      // 更新回滚监管进程：必须在**新版本 asar 已经坏掉**时由 ELECTRON_RUN_AS_NODE 跑起来，所以它故意是
      // CommonJS、故意不依赖打包树里的任何模块。用我们的 TS 规则（禁止 require、要求返回类型）去改它，等于
      // 把一个「进程外救生艇」改成只能在主进程内跑的普通脚本 —— 那就失去意义了。
      'cli/*.cjs',
      // Whole-window find overlay: an ES-module page shipped as a raw resource (not part of the TS source tree).
      'resources/find-overlay/*.js',
      // Git worktrees hold full source copies; don't lint duplicate source from either supported root.
      '**/.claude/**',
      '**/.worktree/**',
      // Codex worktrees (same duplicate-source rationale as .claude/.worktree) and local SDD scratch.
      '**/.codex/**',
      '**/.scratch/**',
      // Local subagent scratch (ledgers, briefs, ad-hoc demo scripts) — never shipped.
      '**/.superpowers/**',
      // Keep official shadcn registry output unmodified; local adaptations live in wrappers.
      'src/renderer/src/components/ui/message-scroller.tsx',
      ...thirdPartySkillIgnores
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // Underscore-prefixed params/vars are intentional placeholders (mock signatures,
      // unused destructure slots); recommended config doesn't exempt them by default.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  eslintConfigPrettier
)
