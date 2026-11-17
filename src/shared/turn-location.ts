// Where the files are, said once per turn.
//
// Real field evidence: twenty-seven failed `Read`/`Edit` calls and twenty-eight scope refusals in
// seventeen days, both from the same confusion — a session runs in a scratch working directory
// (`<data root>/workspaces/<session id>`), while the user's project files live one level up in the
// data root. Nothing in the turn ever said so, so the model looked in the directory it was standing in,
// did not find the file, and reported it missing.
//
// This is context, not the user's words, so it rides in the prepared content rather than request.text.

const WORKSPACES_SEGMENT = '/workspaces/'

/**
 * The project root a session's scratch directory belongs to, or null when the path is not one of ours.
 *
 * Sessions are created under `<root>/workspaces/<session id>`; anything else (a user-chosen folder, a
 * remote path) is left alone rather than guessed at, so this can never claim a root that is not real.
 */
export const projectRootForSessionCwd = (cwd: string): string | null => {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const normalized = cwd.replace(/\/+$/, '')
  const index = normalized.lastIndexOf(WORKSPACES_SEGMENT)
  if (index <= 0) return null
  const root = normalized.slice(0, index)
  return root.length > 1 ? root : null
}

/** '' / null for a turn whose directory carries no project root — such a turn stays byte-identical. */
export const turnLocationDirective = (sessionCwd: string | undefined): string | null => {
  if (typeof sessionCwd !== 'string') return null
  const projectRoot = projectRootForSessionCwd(sessionCwd)
  if (projectRoot === null) return null
  return [
    'WHERE FILES ARE (this turn):',
    `- working directory: ${sessionCwd} — scratch space, for throwaway output only.`,
    `- the user's project files: ${projectRoot} — read and write them there, by absolute path.`,
    'Do not report a project file as missing because it is absent from the working directory.'
  ].join('\n')
}
