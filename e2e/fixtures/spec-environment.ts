/**
 * Environment values a spec needs have to be in force for THAT spec only.
 *
 * Playwright imports every test file in a worker before it runs the first one, so a module-scope
 * `process.env.X = …` is in force for the whole worker from collection time — not from the moment the
 * file's own tests start. A file that runs late (or never restores) therefore changes how every other
 * spec's app launches. The fixture passes `process.env` into `electron.launch`, so anything the child
 * process reads (the fake agent, the provisioner) sees the leaked value.
 *
 * Measured on the packaged P0 lane (Nightly b96f7851, macos-arm64): three specs set
 * `PURESCIENCE_E2E_TOOL_EVENTS = '2'` at module scope, so the fake agent interleaved tool calls into
 * every reply of the whole suite. The four literature-screening specs refuse a backend that touches a
 * tool ("The selected agent attempted to use a tool during literature screening"), so they never
 * produced an AI decision and timed out — while the same spec, run on its own against the same
 * packaged binary in the same job, passed in 10.7 s. The budget was never the problem.
 *
 * Use it from the file's own hooks, never at module scope:
 *
 *   let restoreEnvironment = (): void => {}
 *   test.beforeAll(() => {
 *     restoreEnvironment = scopeEnvironmentToThisSpec({ KEY: value })
 *   })
 *   test.afterAll(() => restoreEnvironment())
 *
 * `test/spec-environment-scope.test.ts` fails the build if a spec assigns `process.env` at module
 * scope again.
 */
export const scopeEnvironmentToThisSpec = (values: Record<string, string>): (() => void) => {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      // Restore rather than delete: the value may have come from the lane (CI or the developer's
      // shell), and removing it would change the next file's launch just as surely as leaving our
      // own value in place.
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
