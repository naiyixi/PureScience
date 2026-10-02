import type { AgentFrameworkId } from '../../shared/settings'
import type { FunctionModelEventReason, FunctionModelId } from '../../shared/function-models'
import type { EffectiveSpecialistSkills } from '../../shared/specialist'
import type { ResolvedAgentBackend } from '../agent-framework'
import { createLogger } from '../logger'
import type {
  ResponsesBridgeSkillCandidate,
  ResponsesBridgeSkillInput
} from '../settings/responses-bridge'
import { AcpSessionPresentationPolicy } from './session-presentation-policy'
const log = createLogger('acp-turn-skill-owner')
const presentation = new AcpSessionPresentationPolicy()
const SKILL_SELECTION_FUNCTION_ID: FunctionModelId = 'skill-selection'
type AcpTurnSkillHooks = Readonly<{
  needForceLoad: (ids: string[]) => Promise<string[]>
  namesForIds: (ids: string[]) => Promise<string[]>
  descriptorsForIds?: (
    ids: string[],
    codexHome: string | undefined
  ) => Promise<ResponsesBridgeSkillInput[]>
  catalogForCodexHome?: (codexHome: string | undefined) => Promise<ResponsesBridgeSkillCandidate[]>
  /**
   * Records why a turn did NOT run the selector, into the same trail the configured model writes to. Without
   * it, "the model I configured was not used" and "the selector never ran" are indistinguishable to a reader:
   * both are simply silence.
   */
  recordFunctionModelEvent?: (event: {
    functionId: FunctionModelId
    outcome: 'built-in'
    reason: FunctionModelEventReason
  }) => void
}>
type TurnSkillOutcome = 'completed' | 'failed' | 'cancelled' | 'reload-restored'
type ProviderPreparationInput = Readonly<{
  frameworkId: AgentFrameworkId
  selectionText: string
  promptText: string
  codex?: Readonly<{
    home?: string
    bridgeSkillsAvailable: boolean
    selectSkills: NonNullable<ResolvedAgentBackend['responsesBridgeLease']>['selectSkills']
    signal?: AbortSignal
  }>
}>
type ProviderPreparation = Readonly<{
  text: string
  specialistSkillGuidance?: string
  codexSkillInputs: readonly ResponsesBridgeSkillInput[]
}>
type TurnSkillHandle = Readonly<{
  reloadDecision: Readonly<{ kind: 'continue' | 'reload' }>
  prepareProvider: (input: ProviderPreparationInput) => Promise<ProviderPreparation>
  close: (outcome: TurnSkillOutcome) => void
}>
type Authorization = {
  outcome?: TurnSkillOutcome
  selectedSkillIds: readonly string[]
  scope?: EffectiveSpecialistSkills
}
class AcpTurnSkillOwner {
  private forced: Authorization | undefined
  constructor(
    private readonly options: Readonly<{
      resolveSpecialistSkills?: (id: string) => Promise<EffectiveSpecialistSkills>
      skills?: AcpTurnSkillHooks
      requestSkillsReload: () => void
    }>
  ) {}
  authorize(input: {
    specialistId?: string
    selectedSkillIds?: readonly string[]
    signal?: AbortSignal
  }): TurnSkillHandle | Promise<TurnSkillHandle> {
    const selected = Object.freeze([...(input.selectedSkillIds ?? [])])
    const finish = (
      scope?: EffectiveSpecialistSkills
    ): TurnSkillHandle | Promise<TurnSkillHandle> => {
      if (scope?.kind === 'unavailable') throw new Error(scope.reason)
      if (scope?.kind === 'specialist') {
        const rejected = selected.find(
          (id) =>
            !scope.skillIds.includes(id) &&
            !(id.startsWith('mcp-') && scope.frameworkNames.includes(id))
        )
        if (rejected) {
          throw new Error(`Skill "${rejected}" is not available to the active specialist.`)
        }
      }
      const create = (disabled: string[]): TurnSkillHandle => {
        const needsReload = disabled.length > 0 && !input.signal?.aborted
        const state: Authorization = {
          selectedSkillIds: selected,
          ...(scope ? { scope } : {})
        }
        if (needsReload) this.forced = state
        return Object.freeze({
          reloadDecision: Object.freeze({ kind: needsReload ? 'reload' : 'continue' }),
          prepareProvider: (providerInput) => this.prepareProvider(state, providerInput),
          close: (outcome) => this.close(state, outcome)
        })
      }
      return this.options.skills && selected.length > 0
        ? this.options.skills.needForceLoad([...selected]).then(create)
        : create([])
    }
    if (!input.specialistId || !this.options.resolveSpecialistSkills) return finish()
    return this.options
      .resolveSpecialistSkills(input.specialistId)
      .catch(
        () => ({ kind: 'unavailable', reason: 'The bound specialist is unavailable.' }) as const
      )
      .then(finish)
  }
  backendPreparation(): Readonly<{ forcedSkillIds: readonly string[] }> {
    return Object.freeze({
      forcedSkillIds: Object.freeze([...(this.forced?.selectedSkillIds ?? [])])
    })
  }
  private close(state: Authorization, outcome: TurnSkillOutcome): void {
    if (state.outcome) return
    state.outcome = outcome
    if (this.forced !== state) return
    this.forced = undefined
    this.options.requestSkillsReload()
  }
  private async prepareProvider(
    state: Authorization,
    input: ProviderPreparationInput
  ): Promise<ProviderPreparation> {
    const skillNames =
      input.frameworkId !== 'codex' && state.selectedSkillIds.length > 0 && this.options.skills
        ? await this.options.skills.namesForIds([...state.selectedSkillIds])
        : []
    const codexSkillInputs = await this.resolveCodexInputs(state, input)
    const presented = presentation.presentTurnSkills({
      frameworkId: input.frameworkId,
      text: input.promptText,
      skillNames,
      codexSkillInputs
    })
    const guidance =
      input.frameworkId !== 'claude-code' && state.scope?.kind === 'specialist'
        ? `Allowed Specialist Skills for this session:\n${state.scope.frameworkNames.map((name) => `- ${name}`).join('\n')}`
        : undefined
    return Object.freeze({
      ...presented,
      ...(guidance ? { specialistSkillGuidance: guidance } : {}),
      codexSkillInputs: Object.freeze(codexSkillInputs)
    })
  }
  private async resolveCodexInputs(
    state: Authorization,
    input: ProviderPreparationInput
  ): Promise<ResponsesBridgeSkillInput[]> {
    if (input.frameworkId !== 'codex') return []
    if (state.selectedSkillIds.length > 0) {
      return (
        this.options.skills?.descriptorsForIds?.([...state.selectedSkillIds], input.codex?.home) ??
        []
      )
    }
    const codex = input.codex
    // Why the selector did not run is a fact about the turn, and it has to be readable: a codex turn whose
    // connection carries no responses bridge cannot reach a selector at all. Kept apart from "nothing was
    // configured" (a model may well be configured) and from "there was nothing to select for".
    if (!codex?.bridgeSkillsAvailable) {
      this.recordSelection('bridge-unavailable')
      return []
    }
    if (!this.options.skills?.catalogForCodexHome) {
      this.recordSelection('call-not-attempted')
      return []
    }
    let catalog: ResponsesBridgeSkillCandidate[]
    try {
      catalog = await this.options.skills.catalogForCodexHome(codex.home)
    } catch {
      return this.selectionFailed('catalog-error')
    }
    if (state.scope?.kind === 'specialist') {
      const allowed = new Set(state.scope.frameworkNames)
      catalog = catalog.filter((skill) => allowed.has(skill.name))
    }
    if (catalog.length === 0) {
      this.recordSelection('call-not-attempted')
      return []
    }
    try {
      const selected = await codex.selectSkills(input.selectionText, catalog, codex.signal)
      if (!selected) return []
      const offered = new Set(catalog.map((skill) => `${skill.name}\u0000${skill.path}`))
      return selected.filter((skill) => offered.has(`${skill.name}\u0000${skill.path}`))
    } catch {
      return this.selectionFailed('selector-error')
    }
  }
  private selectionFailed(reason: 'catalog-error' | 'selector-error'): [] {
    log.warn('Codex Skill selection failed', { reason })
    // A log line nobody reads is not an answer. "The catalog could not be read" (nothing was attempted) and
    // "the selection call failed" are different facts from "nothing was configured", and until this line
    // existed a turn could fail its selection silently — the exact gap the named reasons were added for.
    this.recordSelection(reason === 'catalog-error' ? 'call-not-attempted' : 'call-failed')
    return []
  }

  // The trail entry a turn leaves about its skill selection: why the selector never ran, or why a call it
  // did make failed. Named reasons only — an unnamed entry would put the reader back where they started.
  private recordSelection(reason: FunctionModelEventReason): void {
    this.options.skills?.recordFunctionModelEvent?.({
      functionId: SKILL_SELECTION_FUNCTION_ID,
      outcome: 'built-in',
      reason
    })
  }
}

export { AcpTurnSkillOwner }
export type { AcpTurnSkillHooks, TurnSkillHandle, TurnSkillOutcome }
