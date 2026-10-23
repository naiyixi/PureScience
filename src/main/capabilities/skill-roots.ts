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
  // Every directory the app actually materializes into, each verified live rather than guessed:
  //   • codebuddy writes to `<configRoot>/claude/skills` (same tree as claude-code);
  //   • codex writes its own `<configRoot>/codex/skills` (79 skills, 28 with contracts, on a real run).
  // Missing the codex one is what made a live codex session report `declared: 0` while 28 contracts sat
  // on disk.
  const candidates = [
    join(configRoot, 'skills'),
    join(configRoot, 'claude', 'skills'),
    join(configRoot, 'opencode', 'config', 'opencode', 'skills'),
    join(configRoot, 'codex', 'skills')
  ]
  const present = candidates.filter((dir) => existsSync(dir))
  // Keep the canonical path even when it does not exist yet, so "no such directory" stays a readable
  // answer instead of an empty list a caller could mistake for "no roots configured".
  return present.length > 0 ? present : [candidates[0]]
}
