import { createLogger } from './logger'
import { installAcpIpcHandlers } from './acp/ipc'
import type { AcpHandlerWorkflows } from './acp/handler-workflows'
import type { AcpRuntimeCoordinator } from './acp/runtime-coordinator'
import { installComputeIpcHandlers, type ComputeIpcModule } from './compute/ipc'

type Awaitable<T> = T | Promise<T>

export type InstalledElectronSurfaceAdapter = {
  uninstall(): Awaitable<void>
}

export type NamedElectronSurfaceAdapter = {
  readonly name: string
  install(): Awaitable<InstalledElectronSurfaceAdapter>
}

export type ElectronRuntimeAdapterInterfaces = {
  readonly beforeCompute: readonly NamedElectronSurfaceAdapter[]
  readonly compute: Pick<ComputeIpcModule, 'handlers' | 'enabledComputeHostsRegistry'>
  readonly beforeAcp: readonly NamedElectronSurfaceAdapter[]
  readonly acp: {
    runtime: AcpRuntimeCoordinator
    workflows: AcpHandlerWorkflows
  }
  readonly afterAcp: readonly NamedElectronSurfaceAdapter[]
}

// Production transport wiring for application-owned runtimes. Compute and ACP are required named
// interfaces rather than optional entries in a generic list, so composition cannot silently omit one.
export const installElectronRuntimeAdapters = async ({
  beforeCompute,
  compute,
  beforeAcp,
  acp,
  afterAcp
}: ElectronRuntimeAdapterInterfaces): Promise<InstalledElectronSurfaceAdapter> => {
  const installed: Array<{ name: string; installation: InstalledElectronSurfaceAdapter }> = []
  // One line per surface, because this loop is the last unmeasured stretch of startup: `compose runtime
  // steps` and the module inits together account for less than half of the time between `compose-runtime`
  // and `web-service-started`, and the rest is these installations running one after another.
  const installLog = createLogger('startup')
  const timings: Array<{ surface: string; durationMs: number }> = []
  const install = async (
    name: string,
    operation: () => Awaitable<InstalledElectronSurfaceAdapter>
  ): Promise<void> => {
    const startedAt = performance.now()
    installed.push({ name, installation: await operation() })
    timings.push({ surface: name, durationMs: Math.round(performance.now() - startedAt) })
  }
  const uninstall = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const { installation } of [...installed].reverse()) {
      try {
        await installation.uninstall()
      } catch (error) {
        failures.push(error)
      }
    }
    installed.length = 0
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Electron runtime adapter uninstall failed.')
    }
  }

  try {
    for (const surface of beforeCompute) await install(surface.name, () => surface.install())
    await install('compute', () => installComputeIpcHandlers(compute))
    for (const surface of beforeAcp) await install(surface.name, () => surface.install())
    await install('acp', () => installAcpIpcHandlers(acp.runtime, acp.workflows))
    for (const surface of afterAcp) await install(surface.name, () => surface.install())
  } catch (error) {
    try {
      await uninstall()
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Electron runtime adapter installation and rollback failed.'
      )
    }
    throw error
  }

  // One summary instead of one line per surface: on a real launch every surface installs in 0 ms and the
  // only question is the total and the worst one, which is exactly what the compose summary reports for
  // its own steps. The reading that motivated this: a 1,280 ms gap between `compose-runtime` and
  // `web-service-started` had nothing naming what filled it.
  const slowest = [...timings].sort((left, right) => right.durationMs - left.durationMs).slice(0, 3)
  installLog.info('runtime surfaces installed', {
    count: timings.length,
    totalMs: timings.reduce((sum, entry) => sum + entry.durationMs, 0),
    slowest: slowest.map((entry) => `${entry.surface}=${entry.durationMs}ms`).join(' '),
    processMs: Math.round(performance.now())
  })

  return { uninstall }
}
