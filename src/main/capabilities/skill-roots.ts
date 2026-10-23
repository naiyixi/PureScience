// Where the installed skills actually live.
//
// The app does not keep them in one place: user-installed skills sit in `<configRoot>/skills`, while
// built-ins are materialized into each runtime's own directory (`claude/skills`, opencode's config dir).
// Reading only `<configRoot>/skills` reported "no declared capabilities" on a real install that had 89
// skills — the contracts were there, in a directory nobody scanned.
//
// Order matters: canonical first, mirrors after. The registry keeps a declared contract over a stripped
// duplicate, so a runtime mirror that the ablation blanked cannot erase what the canonical copy says.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const skillCapabilityRoots = (configRoot: string): string[] => {
  // Every directory the app actually materializes into. Verified live, not guessed: `codebuddy` writes
  // to the same `<configRoot>/claude/skills` as claude-code (its create-session log names that configDir),
  // and no `<configRoot>/codebuddy` or `<configRoot>/codex` directory is ever created.
  const candidates = [
    join(configRoot, 'skills'),
    join(configRoot, 'claude', 'skills'),
    join(configRoot, 'opencode', 'config', 'opencode', 'skills')
  ]
  const present = candidates.filter((dir) => existsSync(dir))
  // Keep the canonical path even when it does not exist yet, so "no such directory" stays a readable
  // answer instead of an empty list a caller could mistake for "no roots configured".
  return present.length > 0 ? present : [candidates[0]]
}
