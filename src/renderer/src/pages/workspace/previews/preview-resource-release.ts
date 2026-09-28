// Releasing is best-effort. When the main process owns no such capability — for example right after a window
// is replaced and the command groups are composed again, or while the application is shutting down — there is
// nothing to release, and a rejection surfaces as a renderer console error, which fails unrelated
// certification specs (the renderer-failure gate treats any console error as a failure).
//
// Preview flows call this instead of awaiting `release` directly: the capability is dropped anyway, so a
// failure to release it must never turn into a failed render.

export const releaseQuietly = (resourceId: string): void => {
  void window.api.previewResources.release({ resourceId }).catch(() => undefined)
}
