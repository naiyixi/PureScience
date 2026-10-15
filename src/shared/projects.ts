// Shared project types crossing the main <-> renderer IPC boundary.
//
// The SQLite/Prisma layer owns Project rows (see src/main/projects). Timestamps are normalized to
// epoch milliseconds at the repository boundary so the renderer treats them like session timestamps.

export type Project = {
  id: string
  name: string
  description: string
  isExample: boolean
  // An absent timestamp keeps the Project on active surfaces. Archive is reversible and does not
  // affect the Project's research activity ordering.
  archivedAt?: number
  createdAt: number
  updatedAt: number
}

export type CreateProjectRequest = {
  name: string
  description?: string
}

export type UpdateProjectRequest = {
  id: string
  name?: string
  description?: string
}

export type DeleteProjectRequest = {
  id: string
}

export type UpdateProjectArchiveRequest = {
  id: string
  archived: boolean
  // The last authoritative archive value prevents a stale renderer from restoring or archiving a
  // Project after another window has already changed it.
  expectedArchivedAt: number | null
}

// What a finished Project deletion actually removed from this machine. Every figure is measured on the
// filesystem BEFORE the removal — afterwards it could only be remembered rather than read — so the surface
// can show a number the deletion itself produced instead of an estimate. This is the readable half of
// "deletion has to mean deletion": the bytes are gone AND the user can see how many.
export type ProjectDeletionOutcome = {
  /** Sum of the parts below: everything this deletion removed from project-scoped storage. */
  freedBytes: number
  /** Run data (the project's notebook session directories). */
  runDataBytes: number
  /**
   * Present only when the run data was removed but its size could not be read first: `runDataBytes` (and
   * this slice of `freedBytes`) then carries no reading, so `freedBytes` is a lower bound. A surface must
   * say the run data was released without naming a size instead of reading the 0 as "nothing stored".
   */
  runDataBytesState?: 'unreadable'
  /** Project-scoped artifact and provenance files. */
  artifactBytes: number
  /** Uploaded file versions the project owned. */
  uploadBytes: number
  // What happened to the run data. 'not-attempted' means this call never measured it (no run-data cleaner
  // wired, or the Project row was already gone) — never read it as "there was none".
  runData: 'removed' | 'absent' | 'refused' | 'not-attempted'
}
