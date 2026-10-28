import type { CallerContext } from './caller-context'
import {
  cpuAttributionFields,
  type ActivityAttribution,
  type CpuUsageSample
} from './diagnostics/cpu-attribution'
import { heldSplitForMonotonicWindow, sharedLoopHeldWindows } from './diagnostics/loop-held-windows'

declare const applicationCommandTypes: unique symbol

type Awaitable<Value> = Value | PromiseLike<Value>

type AnyApplicationCommand = Readonly<{ name: string }>

export type ApplicationCommand<
  Name extends string,
  Args extends readonly unknown[],
  Result
> = Readonly<{
  name: Name
  [applicationCommandTypes]?: Readonly<{ args: Args; result: Result }>
}>

type CommandArgs<Command> =
  Command extends ApplicationCommand<string, infer Args, unknown> ? Args : never

type CommandResult<Command> =
  Command extends ApplicationCommand<string, readonly unknown[], infer Result> ? Result : never

export type ApplicationCallerLease = Readonly<{
  leaseId: string
  generation: number
  signal: AbortSignal
  isCurrent: () => boolean
}>

export type ApplicationInvocation<Args extends readonly unknown[]> = Readonly<{
  callerContext: CallerContext
  callerLease: ApplicationCallerLease
  args: Args
}>

export type ApplicationCommandHandler<Args extends readonly unknown[], Result> = (
  invocation: ApplicationInvocation<Args>
) => Awaitable<Result>

export type ApplicationCommandGroup<
  Name extends string,
  Commands extends readonly AnyApplicationCommand[]
> = Readonly<{
  name: Name
  commands: Readonly<Commands>
}>

export type ApplicationCommandHandlers<Commands extends readonly AnyApplicationCommand[]> = {
  readonly [Command in Commands[number] as Command['name']]: Command extends ApplicationCommand<
    string,
    infer Args,
    infer Result
  >
    ? ApplicationCommandHandler<Args, Result>
    : never
}

export type ApplicationCommandInstallation = Readonly<{
  uninstall: () => void
}>

export type ApplicationCommandRegistrationScope = Readonly<{
  registerGroup: <Name extends string, Commands extends readonly AnyApplicationCommand[]>(
    group: ApplicationCommandGroup<Name, Commands>,
    handlers: ApplicationCommandHandlers<Commands>
  ) => void
  complete: (cleanup?: () => void) => ApplicationCommandInstallation
  rollback: () => void
}>

export type ApplicationCommandRegistrar = Readonly<{
  createScope: () => ApplicationCommandRegistrationScope
}>

export type ApplicationCommandDispatcher = Readonly<{
  invoke: <Command extends AnyApplicationCommand>(
    command: Command,
    invocation: ApplicationInvocation<CommandArgs<Command>>
  ) => Promise<CommandResult<Command>>
  commandNames: () => readonly string[]
}>

export type ApplicationCommandDiagnosticCode =
  | 'unknown-command'
  | 'authorization-stale'
  | 'lease-mismatch'
  | 'lease-stale'
  | 'handler-rejected'
  | 'router-disposed'
  // A handler that took longer than SLOW_HANDLER_THRESHOLD_MS. Reported (rather than every call) so the
  // log stays readable while still answering "what did the UI wait for" — the question that the packaged
  // build's first-open hitches raised and that nothing in main could answer before.
  | 'slow-handler'

export type ApplicationCommandDiagnostic = Readonly<{
  code: ApplicationCommandDiagnosticCode
  commandName: string
  // Present on 'slow-handler' and 'handler-rejected': how long the handler itself took, in milliseconds.
  durationMs?: number
  // Present alongside every duration: what this process actually consumed inside the same window. A
  // duration alone cannot separate our own synchronous block from a machine that was not running us (see
  // `cpu-attribution`), so every line that reports one also answers "was the time ours".
  cpuMs?: number
  cpuShare?: number
  attribution?: ActivityAttribution
  // Present only when the stall watchdog saw the loop held inside this window: how much of the wall time
  // the process was not running at all, and the remainder that was ours.
  heldMs?: number
  ownMs?: number
  // Present instead of the split when the stall ring had already dropped the oldest windows: the span cannot
  // be answered for, and reading that as `heldMs: 0` would call a frozen process our own slow work.
  heldUnmeasured?: 'windows-dropped'
}>

// What the invoke path measures around one handler call. Every field but `durationMs` is best-effort: when
// the instrument itself fails, the line degrades to the plain duration rather than losing it.
type HandlerTiming = Readonly<{
  durationMs: number
  cpuMs?: number
  cpuShare?: number
  attribution?: ActivityAttribution
  heldMs?: number
  ownMs?: number
  heldUnmeasured?: 'windows-dropped'
}>

/**
 * Test seam for the attribution instrument. Production passes nothing: the samples come from the process
 * itself and the held windows from the registry the stall watchdog writes.
 */
export type ApplicationCommandRouterDiagnostics = Readonly<{
  now?: () => number
  cpuUsage?: () => CpuUsageSample
  heldMs?: (startMs: number, endMs: number) => number
  heldCoverageStartMs?: () => number | undefined
}>

// Above this, a command's own handler time is worth a log line. Chosen below the 130-430 ms hitches this
// exists to explain (so a first-open cost cannot hide) and above ordinary reads (list-catalog steady is
// ~20 ms), so the log stays quiet when nothing is slow.
const SLOW_HANDLER_THRESHOLD_MS = 50

export type ApplicationCommandRouter = Readonly<{
  registrar: ApplicationCommandRegistrar
  dispatcher: ApplicationCommandDispatcher
  dispose: () => void
}>

type RegisteredHandler = (
  invocation: ApplicationInvocation<readonly unknown[]>
) => Awaitable<unknown>

type RegisteredCommand = Readonly<{
  command: AnyApplicationCommand
  registrationToken: symbol
  handler: RegisteredHandler
}>

type ScopeState = {
  registrations: Array<Readonly<{ commandName: string; registrationToken: symbol }>>
  settled: boolean
  active: boolean
  cleanup?: () => void
  cleanupCalled: boolean
}

export const defineApplicationCommand = <
  const Name extends string,
  Args extends readonly unknown[],
  Result
>(
  name: Name
): ApplicationCommand<Name, Args, Result> =>
  Object.freeze({ name }) as ApplicationCommand<Name, Args, Result>

export const defineApplicationCommandGroup = <
  const Name extends string,
  const Commands extends readonly AnyApplicationCommand[]
>(
  name: Name,
  commands: Commands
): ApplicationCommandGroup<Name, Commands> =>
  Object.freeze({ name, commands: Object.freeze([...commands]) as unknown as Readonly<Commands> })

export const createApplicationCommandRouter = (
  onDiagnostic?: (diagnostic: ApplicationCommandDiagnostic) => void,
  diagnostics: ApplicationCommandRouterDiagnostics = {}
): ApplicationCommandRouter => {
  const commands = new Map<string, RegisteredCommand>()
  const scopes: ScopeState[] = []
  let disposed = false

  const report = (
    code: ApplicationCommandDiagnosticCode,
    commandName: string,
    timing?: HandlerTiming
  ): void => {
    try {
      onDiagnostic?.(
        Object.freeze(
          timing === undefined ? { code, commandName } : { code, commandName, ...timing }
        )
      )
    } catch {
      // Diagnostics must never mask or replace the command result.
    }
  }

  // The held windows are recorded in `performance.now()` (the watchdog's clock, see `loop-held-windows`),
  // while `durationMs` stays on `Date.now()` so the number in the log is the one callers already read.
  const sampleNow = diagnostics.now ?? ((): number => performance.now())
  const cpuUsage = diagnostics.cpuUsage ?? ((): CpuUsageSample => process.cpuUsage())
  const heldMsWithin =
    diagnostics.heldMs ??
    ((startMs: number, endMs: number): number => sharedLoopHeldWindows.heldMsWithin(startMs, endMs))
  // Same registry, same question: how far back are the retained windows complete? Defaults to the shared ring
  // so the marker works in production and not just where a test hands the source over.
  const heldCoverageStartMs =
    diagnostics.heldCoverageStartMs ??
    ((): number | undefined => sharedLoopHeldWindows.coverageStartMs())

  // An instrument that throws must not reach the caller: a dispatch that failed because the diagnostic could
  // not read a clock would be a new failure mode invented by the instrument itself.
  const readNumber = (read: () => number): number | undefined => {
    try {
      const value = read()
      return Number.isFinite(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  const readCpu = (read: () => CpuUsageSample): CpuUsageSample | undefined => {
    try {
      const sample = read()
      const user = Number(sample?.user)
      const system = Number(sample?.system)
      return Number.isFinite(user) && Number.isFinite(system) ? { user, system } : undefined
    } catch {
      return undefined
    }
  }

  // Best-effort by construction: whatever this cannot measure, the line simply does not carry. A missing
  // field means "not measured" and never "zero" — the two read very differently in a log.
  const measure = (
    durationMs: number,
    windowStartedAt: number | undefined,
    cpuStartedAt: CpuUsageSample | undefined
  ): HandlerTiming => {
    if (cpuStartedAt === undefined) return { durationMs }
    try {
      const cpuEndedAt = readCpu(cpuUsage)
      if (cpuEndedAt === undefined) return { durationMs }
      const endedAt = windowStartedAt === undefined ? undefined : readNumber(sampleNow)
      const held =
        windowStartedAt === undefined || endedAt === undefined
          ? undefined
          : heldSplitForMonotonicWindow(windowStartedAt, endedAt, durationMs, {
              heldMsWithin,
              coverageStartMs: heldCoverageStartMs
            })
      return {
        durationMs,
        ...cpuAttributionFields(cpuStartedAt, cpuEndedAt, durationMs),
        // Only when there is something to split, so an ordinary slow handler's line is unchanged.
        ...(held ?? {})
      }
    } catch {
      return { durationMs }
    }
  }

  const removeScope = (state: ScopeState, runCleanup: boolean): void => {
    if (!state.active) return
    state.active = false
    for (const registration of [...state.registrations].reverse()) {
      const current = commands.get(registration.commandName)
      if (current?.registrationToken === registration.registrationToken) {
        commands.delete(registration.commandName)
      }
    }
    if (!runCleanup || state.cleanupCalled || !state.cleanup) return
    state.cleanupCalled = true
    state.cleanup()
  }

  const createScope = (): ApplicationCommandRegistrationScope => {
    if (disposed) throw new Error('Application command router is disposed.')
    const state: ScopeState = {
      registrations: [],
      settled: false,
      active: true,
      cleanupCalled: false
    }
    scopes.push(state)

    return Object.freeze({
      registerGroup: (group, handlers): void => {
        if (disposed) throw new Error('Application command router is disposed.')
        if (state.settled) throw new Error('Application command registration scope is settled.')

        const registrations: Array<
          Readonly<{ command: AnyApplicationCommand; handler: RegisteredHandler }>
        > = []
        const groupNames = new Set<string>()
        const runtimeHandlers = handlers as unknown as Readonly<Record<string, RegisteredHandler>>
        for (const command of group.commands) {
          if (groupNames.has(command.name) || commands.has(command.name)) {
            throw new Error(`Application command is already registered: ${command.name}`)
          }
          if (!Object.hasOwn(runtimeHandlers, command.name)) {
            throw new Error(`Application command handler is missing: ${command.name}`)
          }
          const handler = runtimeHandlers[command.name]
          if (typeof handler !== 'function') {
            throw new Error(`Application command handler is missing: ${command.name}`)
          }
          groupNames.add(command.name)
          registrations.push({ command, handler })
        }

        for (const { command, handler } of registrations) {
          const registrationToken = Symbol(`${group.name}:${command.name}`)
          commands.set(command.name, {
            command,
            registrationToken,
            handler
          })
          state.registrations.push({ commandName: command.name, registrationToken })
        }
      },
      complete: (cleanup): ApplicationCommandInstallation => {
        if (disposed) throw new Error('Application command router is disposed.')
        if (state.settled) throw new Error('Application command registration scope is settled.')
        state.settled = true
        state.cleanup = cleanup
        return Object.freeze({ uninstall: () => removeScope(state, true) })
      },
      rollback: (): void => {
        if (disposed) throw new Error('Application command router is disposed.')
        if (state.settled) return
        state.settled = true
        removeScope(state, false)
      }
    })
  }

  const invoke: ApplicationCommandDispatcher['invoke'] = async (command, invocation) => {
    if (disposed) {
      report('router-disposed', command.name)
      throw new Error('Application command router is disposed.')
    }
    const registered = commands.get(command.name)
    if (!registered || registered.command !== command) {
      report('unknown-command', command.name)
      throw new Error(`Unknown application command: ${command.name}`)
    }
    if (!invocation.callerContext.isAuthorizationCurrent()) {
      report('authorization-stale', command.name)
      throw new Error('Caller authorization is no longer current.')
    }
    if (invocation.callerLease.leaseId !== invocation.callerContext.leaseId) {
      report('lease-mismatch', command.name)
      throw new Error('Caller lease does not match caller context.')
    }
    if (invocation.callerLease.signal.aborted || !invocation.callerLease.isCurrent()) {
      report('lease-stale', command.name)
      throw new Error('Caller lease is no longer current.')
    }

    const startedAt = Date.now()
    const windowStartedAt = readNumber(sampleNow)
    const cpuStartedAt = readCpu(cpuUsage)
    try {
      const result = (await registered.handler(invocation)) as CommandResult<typeof command>
      const durationMs = Date.now() - startedAt
      if (durationMs >= SLOW_HANDLER_THRESHOLD_MS) {
        report('slow-handler', command.name, measure(durationMs, windowStartedAt, cpuStartedAt))
      }
      return result
    } catch (error) {
      // A rejection used to say nothing about how long we had already waited. A command that threw after
      // 700 ms of our own CPU raises the same question the slow line answers, so it carries the same fields
      // — the failure branch is exactly where "was the time ours" is hardest to reconstruct afterwards.
      report(
        'handler-rejected',
        command.name,
        measure(Date.now() - startedAt, windowStartedAt, cpuStartedAt)
      )
      throw error
    }
  }

  return Object.freeze({
    registrar: Object.freeze({ createScope }),
    dispatcher: Object.freeze({
      invoke,
      commandNames: (): readonly string[] => [...commands.keys()].sort()
    }),
    dispose: (): void => {
      if (disposed) return
      disposed = true
      const failures: unknown[] = []
      for (const state of [...scopes].reverse()) {
        try {
          removeScope(state, state.settled)
        } catch (error) {
          failures.push(error)
        }
      }
      commands.clear()
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Application command cleanup failed.')
      }
    }
  })
}
