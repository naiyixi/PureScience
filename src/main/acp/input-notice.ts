// Builds the input pre-check notice for a turn (D5).
//
// Deliberately separate from the prompt text: the user's own message is recorded from that text, so
// anything the application wants the model to know rides in the provider content instead. The
// filesystem is injected so the decision is testable without touching disk.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { assessInputPaths, buildMissingInputNotice } from '../../shared/input-precheck'

export type InputNoticeResolver = {
  /** '' when nothing the task names is missing, so an ordinary turn is untouched. */
  forTurn: (text: string, cwd: string | undefined) => string
}

// A path the task names may be absolute, home-relative or relative to the session's working directory.
const resolveCandidate = (candidate: string, cwd: string | undefined): string => {
  if (candidate.startsWith('~/')) return join(homedir(), candidate.slice(2))
  if (isAbsolute(candidate)) return candidate
  return join(cwd ?? homedir(), candidate)
}

export const createInputNoticeResolver = (
  exists: (absolutePath: string) => boolean = existsSync
): InputNoticeResolver => ({
  forTurn: (text, cwd) =>
    buildMissingInputNotice(
      assessInputPaths(text ?? '', (candidate) => exists(resolveCandidate(candidate, cwd)))
    )
})
