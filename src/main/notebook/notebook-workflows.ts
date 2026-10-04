import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  ExportNotebookAllRequest,
  ExportNotebookAllResult,
  ExportNotebookKernelRequest,
  ExportNotebookResult,
  FinishNotebookCodeCellRequest,
  InspectNotebookVariablesRequest,
  InspectNotebookVariablesResult,
  NotebookCell,
  NotebookRunSummary,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionState,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type {
  NotebookRuntimeBinding,
  NotebookRuntimeBindings,
  NotebookRuntimeBindingRequest,
  NotebookRuntimeListing
} from '../../shared/notebook-runtime'
import { withDataRootWrite } from '../storage/migration-state'

type BeginNotebookCodeCellResult = {
  sessionId: string
  cellId: string
  writeId: string
  status: NotebookCell['status']
}

type AppendNotebookCodeCellResult = {
  sessionId: string
  cellId: string
  writeId: string
  receivedBytes: number
}

type FinishNotebookCodeCellResult = {
  sessionId: string
  cellId: string
  code: string
  status: NotebookCell['status']
}

type NotebookShutdownResult = { sessionId: string; status: 'shutdown' }

type NotebookCommandRuntime = {
  state(request: NotebookSessionRequest): Promise<NotebookSessionState>
  getSessionReference(request: NotebookSessionRequest): Promise<NotebookSessionReference | null>
  beginCodeCell(request: BeginNotebookCodeCellRequest): Promise<BeginNotebookCodeCellResult>
  appendCodeCell(request: AppendNotebookCodeCellRequest): Promise<AppendNotebookCodeCellResult>
  finishCodeCell(request: FinishNotebookCodeCellRequest): Promise<FinishNotebookCodeCellResult>
  runCell(request: RunNotebookCellRequest): Promise<NotebookRunSummary>
  execute(request: ExecuteNotebookCodeRequest): Promise<NotebookRunSummary>
  exportIpynb(request: ExportNotebookKernelRequest): Promise<ExportNotebookResult>
  exportIpynbAll(request: ExportNotebookAllRequest): Promise<ExportNotebookAllResult>
  restart(request: NotebookSessionRequest): Promise<NotebookSessionState>
  shutdown(request: NotebookSessionRequest): Promise<NotebookShutdownResult>
  inspectVariables(
    request: InspectNotebookVariablesRequest
  ): Promise<InspectNotebookVariablesResult | undefined>
  // IC14: the session's runtime bindings, surfaced to the window through the SAME main-process gate the
  // agent's list_notebook_runtimes / notebook_bind_runtime / notebook_switch_runtime already use: a
  // disabled or unknown runtime is refused there, and a switch tears the old kernel down before rebinding.
  listRuntimes(request: NotebookSessionRequest): Promise<NotebookRuntimeListingResult>
  bindRuntime(request: NotebookRuntimeBindingRequest): Promise<NotebookRuntimeBindingResult>
  switchRuntime(request: NotebookRuntimeBindingRequest): Promise<NotebookRuntimeBindingResult>
}

type NotebookCommandWorkflows = {
  state(request: NotebookSessionRequest): Promise<NotebookSessionState>
  reference(request: NotebookSessionRequest): Promise<NotebookSessionReference | null>
  beginCodeCell(request: BeginNotebookCodeCellRequest): Promise<BeginNotebookCodeCellResult>
  appendCodeCell(request: AppendNotebookCodeCellRequest): Promise<AppendNotebookCodeCellResult>
  finishCodeCell(request: FinishNotebookCodeCellRequest): Promise<FinishNotebookCodeCellResult>
  runCell(request: RunNotebookCellRequest): Promise<NotebookRunSummary>
  execute(request: ExecuteNotebookCodeRequest): Promise<NotebookRunSummary>
  exportIpynb(request: ExportNotebookKernelRequest): Promise<ExportNotebookResult>
  exportIpynbAll(request: ExportNotebookAllRequest): Promise<ExportNotebookAllResult>
  restart(request: NotebookSessionRequest): Promise<NotebookSessionState>
  shutdown(request: NotebookSessionRequest): Promise<NotebookShutdownResult>
  inspectVariables(
    request: InspectNotebookVariablesRequest
  ): Promise<InspectNotebookVariablesResult | undefined>
  // IC14: the session's runtime bindings, surfaced to the window through the SAME main-process gate the
  // agent's list_notebook_runtimes / notebook_bind_runtime / notebook_switch_runtime already use: a
  // disabled or unknown runtime is refused there, and a switch tears the old kernel down before rebinding.
  listRuntimes(request: NotebookSessionRequest): Promise<NotebookRuntimeListingResult>
  bindRuntime(request: NotebookRuntimeBindingRequest): Promise<NotebookRuntimeBindingResult>
  switchRuntime(request: NotebookRuntimeBindingRequest): Promise<NotebookRuntimeBindingResult>
}

// IC14: the window-facing RESULT shapes for a session's runtime binding. Named here (not spelled inline
// three times) so the workflow port, the IPC adapter and the preload bridge all describe one thing; the
// request side is shared, because the renderer's own type surface needs it too.
type NotebookRuntimeListingResult = {
  runtimes: NotebookRuntimeListing[]
  bindings: NotebookRuntimeBindings
}
type NotebookRuntimeBindingResult = {
  bound: NotebookRuntimeBinding
  bindings: NotebookRuntimeBindings
}

const withoutTrustedTurnContext = <
  Request extends
    RunNotebookCellRequest | ExecuteNotebookCodeRequest | InspectNotebookVariablesRequest
>(
  request: Request
): Request => {
  const { provenanceContext, registeredInputFiles, inputRunLeaseId, ...publicRequest } = request
  void provenanceContext
  void registeredInputFiles
  void inputRunLeaseId
  return publicRequest as Request
}

const createNotebookCommandWorkflows = (
  runtime: NotebookCommandRuntime
): NotebookCommandWorkflows => ({
  state: (request) => runtime.state(request),
  reference: (request) => runtime.getSessionReference(request),
  beginCodeCell: (request) => withDataRootWrite(() => runtime.beginCodeCell(request)),
  appendCodeCell: (request) => withDataRootWrite(() => runtime.appendCodeCell(request)),
  finishCodeCell: (request) => withDataRootWrite(() => runtime.finishCodeCell(request)),
  runCell: (request) =>
    withDataRootWrite(() => runtime.runCell(withoutTrustedTurnContext(request))),
  execute: (request) =>
    withDataRootWrite(() => runtime.execute(withoutTrustedTurnContext(request))),
  exportIpynb: (request) => runtime.exportIpynb(request),
  exportIpynbAll: (request) => runtime.exportIpynbAll(request),
  restart: (request) => withDataRootWrite(() => runtime.restart(request)),
  shutdown: (request) => withDataRootWrite(() => runtime.shutdown(request)),
  inspectVariables: (request) =>
    withDataRootWrite(() => runtime.inspectVariables(withoutTrustedTurnContext(request))),
  // A read: listing never starts a kernel, so it needs no write lease.
  listRuntimes: (request) => runtime.listRuntimes(request),
  // Both of these mutate the session (and a switch tears a kernel down first), so they take the same
  // data-root write lease as every other notebook mutation.
  bindRuntime: (request) => withDataRootWrite(() => runtime.bindRuntime(request)),
  switchRuntime: (request) => withDataRootWrite(() => runtime.switchRuntime(request))
})

export { createNotebookCommandWorkflows }
export type { NotebookCommandRuntime, NotebookCommandWorkflows }
