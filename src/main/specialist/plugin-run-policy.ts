import {
  policyDeniesUnprotectedExecution,
  rememberedApprovalCoversUnprotected,
  type ExecutionProtectionSnapshot,
  type RemoteUnprotectedExecutionPolicy
} from '../../shared/execution-protection'

// E3-2: the gate every plugin operation passes through, and the reason it is its own module.
//
// Deploying files into the app's own data root and EXECUTING code taken from a public repository are
// different acts, and only the second one is "unprotected execution" — the thing this app's protection
// policy exists to decide. So the gate names both, and consults the SAME policy the rest of the app does
// instead of inventing a second opinion about what may run.

export type PluginOperation = 'deploy' | 'run-once'

/** What each operation does, in the sentence a reader is asked to accept. */
export const PLUGIN_OPERATION_RULE: Record<PluginOperation, string> = {
  deploy: "writes the plugin's own files into the app's data root",
  'run-once': 'executes code taken from a public repository'
}

export type PluginOperationDecision =
  | { state: 'allowed'; detail: string }
  | {
      state: 'refused'
      reason: 'confirmation-missing' | 'unprotected-execution-denied' | 'approval-required'
      detail: string
    }

export const decidePluginOperation = (input: {
  operation: PluginOperation
  /** True only when the caller's own interface asked, naming what happens (see PLUGIN_OPERATION_RULE). */
  confirmed: boolean
  protection: ExecutionProtectionSnapshot
  policy: RemoteUnprotectedExecutionPolicy
}): PluginOperationDecision => {
  const rule = PLUGIN_OPERATION_RULE[input.operation]

  // Nothing happens without an explicit confirmation: a silent deploy is a file write nobody asked for.
  if (!input.confirmed) {
    return {
      state: 'refused',
      reason: 'confirmation-missing',
      detail: `${input.operation} ${rule}; it was not confirmed.`
    }
  }

  // Writing the plugin's files is a local, user-confirmed write: it is not execution, and the protection
  // policy has nothing to say about it. Running the code is a separate decision, and says so here.
  if (input.operation === 'deploy') {
    return {
      state: 'allowed',
      detail: 'deploy writes files only; running them is a separate decision.'
    }
  }

  const { level, scope } = input.protection
  if (policyDeniesUnprotectedExecution(input.policy, level)) {
    return {
      state: 'refused',
      reason: 'unprotected-execution-denied',
      detail: `The execution-protection policy denies unprotected execution (filesystem: ${scope.filesystem}, network: ${scope.network}), and this run would be unprotected.`
    }
  }
  if (level === 'unprotected' && !rememberedApprovalCoversUnprotected(input.policy)) {
    return {
      state: 'refused',
      reason: 'approval-required',
      detail: `This run would be unprotected (filesystem: ${scope.filesystem}, network: ${scope.network}); the policy does not remember approvals, so it needs one per run.`
    }
  }

  return {
    state: 'allowed',
    detail: `Runs under protection level ${level} (policy ${input.policy}).`
  }
}
